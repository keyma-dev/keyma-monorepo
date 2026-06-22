#pragma once

// KeymaServer for @keyma/runtime-cpp (a faithful port of runtime-js `server.ts`).
// Templated on the async policy (default Sync). The operation handlers mirror the JS
// control flow step-for-step: the synchronous stages (reference normalization, defaults,
// formatting, validation, projection building) run eagerly and may throw; the asynchronous
// stages (adapter calls and the plugin-hook folds) are chained through async_traits<Async>.
//
// Lifetime note: a handler builds a chain of continuations over `Async`. For Async=Sync the
// whole chain runs synchronously inside `handle`, so referencing the request/context/schema
// by pointer is safe. For a deferred policy the contract is that the request and context
// passed to `handle` must outlive the returned Async (the standard bring-your-own-scheduler
// requirement), and plugins/adapters must capture by value what they need across suspension.

#include <keyma/adapter.hpp>
#include <keyma/async.hpp>
#include <keyma/defaults.hpp>
#include <keyma/errors.hpp>
#include <keyma/format.hpp>
#include <keyma/plugin.hpp>
#include <keyma/protocol.hpp>
#include <keyma/runtime.hpp>
#include <keyma/serialize.hpp>
#include <keyma/service.hpp>
#include <keyma/validate.hpp>

#include <format>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <variant>

namespace keyma {

namespace server_detail {
inline std::string_view sv_at(const Value& v, std::string_view key) {
    const Value* p = v.find(key);
    return (p != nullptr && p->is_string()) ? std::string_view(p->as_string()) : std::string_view{};
}
inline bool is_one(const Value& v) { return v.is_number() && v.as_int() == 1; }
}  // namespace server_detail

template <template <class> class Async = Sync>
class KeymaServer : public PluginServerHandle<Async> {
public:
    using AT = async_traits<Async>;
    template <class T> using A = Async<T>;

    struct Options {
        std::span<const SchemaMeta* const> schemas{};
        KeymaDatabaseAdapter<Async>* adapter = nullptr;
        std::span<KeymaServerPlugin<Async>* const> plugins{};
        std::span<Service<Async>* const> services{};
        alloc_t alloc{};
    };

    explicit KeymaServer(Options opts)
        : adapter_(opts.adapter), a_(opts.alloc),
          schemas_(opts.alloc), schema_map_(opts.alloc), plugins_(opts.alloc), service_map_(opts.alloc) {
        for (const SchemaMeta* s : opts.schemas) {
            schemas_.push_back(s);
            schema_map_.push_back({s->name, s});
        }
        for (KeymaServerPlugin<Async>* p : opts.plugins) plugins_.push_back(p);
        for (Service<Async>* svc : opts.services) {
            const ServiceMeta& m = svc->meta();
            if (find_service(m.name) != nullptr)
                throw KeymaRuntimeError("DUPLICATE_SERVICE",
                                        std::format("Service \"{}\" is registered more than once", m.name));
            service_map_.push_back({m.name, svc});
        }
    }

    // ── Public API ──

    A<void> ensure_schemas() {
        return AT::then(ensure_initialized(), [this]() -> A<void> {
            return AT::then(
                seq_fold<Async>(schemas_.data(), schemas_.data() + schemas_.size(), std::monostate{},
                    [this](std::monostate s, const SchemaMeta* schema) -> A<std::monostate> {
                        if (schema->ephemeral) return AT::ready(s);
                        return AT::then(adapter_->ensure_schema(*schema), [s]() { return s; });
                    }),
                [](std::monostate) {});
        });
    }

    A<Value> handle(Value request, RequestContext ctx = {}) {
        return AT::then(ensure_initialized(),
            [this, request = std::move(request), ctx = std::move(ctx)]() mutable {
                return handle_after_init(std::move(request), std::move(ctx));
            });
    }

    A<void> close() { return adapter_->close(); }

    // ── PluginServerHandle<Async> ──
    std::span<const SchemaMeta* const> schemas() const override {
        return std::span<const SchemaMeta* const>(schemas_.data(), schemas_.size());
    }
    KeymaDatabaseAdapter<Async>& adapter() const override { return *adapter_; }
    const SchemaMeta* schema(std::string_view name) const override { return find_schema(name); }
    A<void> add_schema(const SchemaMeta& s) override {
        schema_map_.push_back({s.name, &s});
        schemas_.push_back(&s);
        if (s.ephemeral) return AT::ready();
        return adapter_->ensure_schema(s);
    }

private:
    // ── Lookups / predicates ──
    const SchemaMeta* find_schema(std::string_view name) const {
        for (const auto& e : schema_map_) if (e.first == name) return e.second;
        return nullptr;
    }
    Service<Async>* find_service(std::string_view name) const {
        for (const auto& e : service_map_) if (e.first == name) return e.second;
        return nullptr;
    }
    static bool is_system(const RequestContext& ctx) {
        const Value* id = ctx.find("identity");
        if (id == nullptr) return false;
        const Value* sys = id->find("isSystem");
        return sys != nullptr && sys->is_bool() && sys->as_bool();
    }
    const SchemaMeta* resolve_schema(std::string_view name, const RequestContext& ctx) const {
        const SchemaMeta* s = find_schema(name);
        if (s == nullptr || (s->visibility == Visibility::Private && !is_system(ctx)))
            throw KeymaRuntimeError("SCHEMA_NOT_FOUND", std::format("Unknown schema: {}", name));
        return s;
    }

    // ── Initialization ──
    A<void> ensure_initialized() {
        if (initialized_) return AT::ready();
        initialized_ = true;
        return AT::then(adapter_->connect(), [this]() -> A<void> {
            return AT::then(
                seq_fold<Async>(plugins_.data(), plugins_.data() + plugins_.size(), std::monostate{},
                    [this](std::monostate s, KeymaServerPlugin<Async>* p) -> A<std::monostate> {
                        if (!p->has_init()) return AT::ready(s);
                        return AT::then(p->init(*this), [s]() { return s; });
                    }),
                [](std::monostate) {});
        });
    }

    A<Value> handle_after_init(Value request, RequestContext ctx) {
        Value results = Value::object(a_);
        const Value* ops = request.find("operations");
        if (ops == nullptr || !ops->is_object())
            return AT::ready(proto::batch_response(std::move(results), a_));
        const Value::Object& obj = ops->as_object();
        return AT::then(
            seq_fold<Async>(obj.data(), obj.data() + obj.size(), std::move(results),
                [this, &ctx](Value acc, const Value::Member& m) -> A<Value> {
                    std::pmr::string key(std::string_view(m.key), a_);
                    return AT::then(handle_one(Value(m.value, a_), ctx),
                        [acc = std::move(acc), key = std::move(key)](Value result) mutable {
                            acc.set(std::string_view(key), std::move(result));
                            return acc;
                        });
                }),
            [this](Value acc) { return proto::batch_response(std::move(acc), a_); });
    }

    // ── Per-operation pipeline ──
    A<Value> handle_one(Value op, const RequestContext& ctx) {
        // transformOperation fold (a plugin may replace the whole op).
        A<Value> transformed = seq_fold<Async>(plugins_.data(), plugins_.data() + plugins_.size(), std::move(op),
            [this, &ctx](Value acc, KeymaServerPlugin<Async>* p) -> A<Value> {
                if (!p->has_transform_operation()) return AT::ready(std::move(acc));
                return AT::then(p->transform_operation(ctx, acc),
                    [acc = std::move(acc)](std::optional<Value> next) mutable {
                        return next.has_value() ? std::move(*next) : std::move(acc);
                    });
            });

        return AT::then(std::move(transformed), [this, &ctx](Value op) {
            A<Value> guarded = AT::attempt(
                [this, &ctx, &op]() -> A<Value> { return dispatch_after_transform(op, ctx); },
                [this](std::exception_ptr e) { return error_to_result(e, a_); });
            // afterOperation fold runs regardless of outcome and swallows its own errors.
            return AT::then(std::move(guarded), [this, &ctx, op = std::move(op)](Value result) mutable {
                return AT::then(
                    seq_fold<Async>(plugins_.data(), plugins_.data() + plugins_.size(), std::monostate{},
                        [this, &ctx, &op, &result](std::monostate s, KeymaServerPlugin<Async>* p) -> A<std::monostate> {
                            if (!p->has_after_operation()) return AT::ready(s);
                            return AT::then(
                                AT::swallow([&]() -> A<void> { return p->after_operation(ctx, op, result); }),
                                [s]() { return s; });
                        }),
                    [result = std::move(result)](std::monostate) mutable { return std::move(result); });
            });
        });
    }

    A<Value> dispatch_after_transform(const Value& op, const RequestContext& ctx) {
        std::string_view kind = proto::op_kind(op);
        if (kind == "call") {
            return AT::then(run_before_operation(ctx, op),
                [this, &op, &ctx]() { return handle_call(op, ctx); });
        }
        const SchemaMeta* schema = resolve_schema(proto::op_schema(op), ctx);
        if (schema->ephemeral)
            throw KeymaRuntimeError("NOT_PERSISTED",
                                    std::format("Schema \"{}\" is ephemeral and cannot be queried", schema->name));
        return AT::then(run_before_operation(ctx, op), [this, schema, &op, &ctx]() -> A<Value> {
            std::string_view k = proto::op_kind(op);
            if (k == "list") return handle_list(*schema, op, ctx);
            if (k == "read") return handle_read(*schema, op, ctx);
            if (k == "create") return handle_create(*schema, op, ctx);
            if (k == "update") return handle_update(*schema, op, ctx);
            if (k == "delete") return handle_delete(*schema, op, ctx);
            if (k == "traverse") return handle_traverse(*schema, op, ctx);
            if (k == "count") return handle_count(*schema, op, ctx);
            throw KeymaRuntimeError("UNKNOWN_OP", std::format("Unknown operation: {}", k));
        });
    }

    // ── Handlers ──
    A<Value> handle_list(const SchemaMeta& schema, const Value& op, const RequestContext& ctx) {
        Value where = op.find("where") != nullptr ? Value(op.at("where"), a_) : Value::object(a_);
        return AT::then(run_filter_hooks(ctx, schema, std::move(where), KeymaAction::List),
            [this, &schema, &op, &ctx](Value where) mutable {
                AdapterProjection proj = build_adapter_projection(schema, op.find("project"), is_system(ctx));
                return AT::then(run_projection_hooks(ctx, schema, std::move(proj), KeymaAction::List),
                    [this, &schema, &op, &ctx, where = std::move(where)](AdapterProjection proj) mutable {
                        ListQuery q = make_list_query(op, std::move(where), std::move(proj));
                        return AT::then(adapter_->list(schema, std::move(q)),
                            [this, &schema, &ctx](std::pmr::vector<Value> records) {
                                return AT::then(run_result_hooks(ctx, schema, std::move(records), KeymaAction::List),
                                    [this](std::pmr::vector<Value> out) {
                                        return proto::ok_result(array_of(std::move(out)), a_);
                                    });
                            });
                    });
            });
    }

    A<Value> handle_read(const SchemaMeta& schema, const Value& op, const RequestContext& ctx) {
        Value where = Value(op.at("where"), a_);
        return AT::then(run_filter_hooks(ctx, schema, std::move(where), KeymaAction::Read),
            [this, &schema, &op, &ctx](Value where) mutable {
                AdapterProjection proj = build_adapter_projection(schema, op.find("project"), is_system(ctx));
                return AT::then(run_projection_hooks(ctx, schema, std::move(proj), KeymaAction::Read),
                    [this, &schema, &ctx, where = std::move(where)](AdapterProjection proj) mutable {
                        return AT::then(adapter_->read(schema, std::move(where), std::move(proj)),
                            [this, &schema, &ctx](Value record) -> A<Value> {
                                if (record.is_null()) throw KeymaRuntimeError("NOT_FOUND", "Not found");
                                std::pmr::vector<Value> one(a_);
                                one.push_back(Value(record, a_));
                                return AT::then(run_result_hooks(ctx, schema, std::move(one), KeymaAction::Read),
                                    [this, record = std::move(record)](std::pmr::vector<Value> out) mutable {
                                        return proto::ok_result(out.empty() ? std::move(record) : std::move(out[0]), a_);
                                    });
                            });
                    });
            });
    }

    A<Value> handle_create(const SchemaMeta& schema, const Value& op, const RequestContext& ctx) {
        Value data = normalize_reference_ids(op.at("data"), schema, a_);
        apply_defaults(schema, data, a_);
        format(schema, data, Phase::Save);
        auto errs = validate_if(schema, data, a_, [](const FieldMeta& f) { return f.name != "id"; });
        if (!errs.empty()) throw ValidationFailedError(std::move(errs));
        return AT::then(run_write_hooks(ctx, schema, std::move(data), KeymaWriteAction::Create),
            [this, &schema, &op, &ctx](Value data) mutable {
                AdapterProjection proj = build_adapter_projection(schema, op.find("project"), is_system(ctx));
                return AT::then(run_projection_hooks(ctx, schema, std::move(proj), KeymaAction::Create),
                    [this, &schema, &ctx, data = std::move(data)](AdapterProjection proj) mutable {
                        return AT::then(adapter_->create(schema, std::move(data), std::move(proj)),
                            [this, &schema, &ctx](Value created) {
                                std::pmr::vector<Value> one(a_);
                                one.push_back(std::move(created));
                                return AT::then(run_result_hooks(ctx, schema, std::move(one), KeymaAction::Create),
                                    [this](std::pmr::vector<Value> out) {
                                        return proto::ok_result(out.empty() ? Value(nullptr, a_) : std::move(out[0]), a_);
                                    });
                            });
                    });
            });
    }

    A<Value> handle_update(const SchemaMeta& schema, const Value& op, const RequestContext& ctx) {
        Value data = normalize_reference_ids(op.at("data"), schema, a_);
        format(schema, data, Phase::Save);
        // Partial update: validate only the supplied fields, so absent fields don't trip `required`.
        auto errs = validate_if(schema, data, a_,
                                [&data](const FieldMeta& f) { return data.find(f.name) != nullptr; });
        if (!errs.empty()) throw ValidationFailedError(std::move(errs));
        return AT::then(run_write_hooks(ctx, schema, std::move(data), KeymaWriteAction::Update),
            [this, &schema, &op, &ctx](Value data) mutable {
                Value where = Value(op.at("where"), a_);
                return AT::then(run_filter_hooks(ctx, schema, std::move(where), KeymaAction::Update),
                    [this, &schema, &op, &ctx, data = std::move(data)](Value where) mutable {
                        AdapterProjection proj = build_adapter_projection(schema, op.find("project"), is_system(ctx));
                        return AT::then(run_projection_hooks(ctx, schema, std::move(proj), KeymaAction::Update),
                            [this, &schema, &ctx, data = std::move(data), where = std::move(where)](AdapterProjection proj) mutable {
                                return AT::then(adapter_->update(schema, std::move(where), std::move(data), std::move(proj)),
                                    [this, &schema, &ctx](Value updated) {
                                        std::pmr::vector<Value> one(a_);
                                        one.push_back(std::move(updated));
                                        return AT::then(run_result_hooks(ctx, schema, std::move(one), KeymaAction::Update),
                                            [this](std::pmr::vector<Value> out) {
                                                return proto::ok_result(out.empty() ? Value(nullptr, a_) : std::move(out[0]), a_);
                                            });
                                    });
                            });
                    });
            });
    }

    A<Value> handle_delete(const SchemaMeta& schema, const Value& op, const RequestContext& ctx) {
        Value where = Value(op.at("where"), a_);
        return AT::then(run_filter_hooks(ctx, schema, std::move(where), KeymaAction::Delete),
            [this, &schema](Value where) mutable {
                return AT::then(adapter_->del(schema, std::move(where)),
                                [this]() { return proto::ok_result(Value(nullptr, a_), a_); });
            });
    }

    A<Value> handle_count(const SchemaMeta& schema, const Value& op, const RequestContext& ctx) {
        Value where = op.find("where") != nullptr ? Value(op.at("where"), a_) : Value::object(a_);
        return AT::then(run_filter_hooks(ctx, schema, std::move(where), KeymaAction::Count),
            [this, &schema](Value where) mutable {
                return AT::then(adapter_->count(schema, std::move(where)),
                                [this](std::int64_t n) { return proto::ok_result(Value(n, a_), a_); });
            });
    }

    A<Value> handle_traverse(const SchemaMeta& terminal, const Value& op, const RequestContext& ctx) {
        if (!adapter_->capabilities().traverse)
            throw KeymaRuntimeError("UNSUPPORTED", "Database adapter does not support traverse operations");
        const Value& spec = op.at("spec");
        const SchemaMeta* start = resolve_schema(server_detail::sv_at(spec.at("start"), "schema"), ctx);

        AdapterTraversalContext tctx(a_);
        tctx.terminal_schema = &terminal;
        tctx.start_schema = start;
        auto add_edge = [&](std::string_view name) {
            const SchemaMeta* s = resolve_schema(name, ctx);
            if (s->edge == nullptr)
                throw KeymaRuntimeError("NOT_AN_EDGE", std::format("Schema \"{}\" is not an edge schema", name));
            tctx.edges.push_back({name, s});
            for (std::string_view endpoint : {s->edge->from, s->edge->to}) {
                const SchemaMeta* node = find_schema(endpoint);
                if (node != nullptr) tctx.nodes.push_back({node->name, node});
            }
        };
        const Value* steps = spec.find("steps");
        if (steps != nullptr && steps->is_array())
            for (const Value& st : steps->as_array()) add_edge(server_detail::sv_at(st, "via"));
        const Value* repeat = spec.find("repeat");
        if (repeat != nullptr && repeat->is_object()) add_edge(server_detail::sv_at(*repeat, "via"));
        tctx.nodes.push_back({start->name, start});
        tctx.nodes.push_back({terminal.name, &terminal});

        AdapterProjection proj = build_adapter_projection(terminal, op.find("project"), is_system(ctx));
        return AT::then(run_projection_hooks(ctx, terminal, std::move(proj), KeymaAction::Traverse),
            [this, &terminal, &ctx, tctx = std::move(tctx), spec = Value(spec, a_)](AdapterProjection proj) mutable {
                return AT::then(adapter_->traverse(tctx, std::move(spec), std::move(proj)),
                    [this, &terminal, &ctx](Value records) -> A<Value> {
                        if (records.is_array() && all_plain_records(records)) {
                            std::pmr::vector<Value> recs(a_);
                            for (const Value& r : records.as_array()) recs.push_back(Value(r, a_));
                            return AT::then(run_result_hooks(ctx, terminal, std::move(recs), KeymaAction::Traverse),
                                [this](std::pmr::vector<Value> out) {
                                    return proto::ok_result(array_of(std::move(out)), a_);
                                });
                        }
                        return AT::ready(proto::ok_result(std::move(records), a_));
                    });
            });
    }

    A<Value> handle_call(const Value& op, const RequestContext& ctx) {
        const bool sys = is_system(ctx);
        std::string_view service_name = server_detail::sv_at(op, "service");
        Service<Async>* svc = find_service(service_name);
        if (svc == nullptr || (svc->meta().visibility == Visibility::Private && !sys))
            throw KeymaRuntimeError("SERVICE_NOT_FOUND", std::format("Unknown service: {}", service_name));
        const ServiceMeta& meta = svc->meta();
        std::string_view method_name = server_detail::sv_at(op, "method");
        const ServiceMethodMeta* method = nullptr;
        for (const ServiceMethodMeta& mm : meta.methods)
            if (mm.name == method_name) { method = &mm; break; }
        if (method == nullptr || (method->visibility == Visibility::Private && !sys))
            throw KeymaRuntimeError("METHOD_NOT_FOUND",
                                    std::format("Unknown method \"{}\" on service \"{}\"", method_name, service_name));
        const Value& args = op.at("args");
        // Validate schema-typed arguments against their input schemas.
        std::pmr::vector<ValidationError> errs(a_);
        for (const ServiceParamMeta& param : method->params) {
            if (param.schema.empty()) continue;
            const SchemaMeta* ps = find_schema(param.schema);
            if (ps == nullptr) continue;
            const Value* v = args.find(param.name);
            if (v != nullptr && !v->is_null()) {
                auto pe = validate(*ps, *v, a_);
                for (ValidationError& e : pe) errs.push_back(std::move(e));
            }
        }
        if (!errs.empty()) throw ValidationFailedError(std::move(errs));
        return AT::then(svc->dispatch(method_name, args, ctx),
                        [this](Value data) { return proto::ok_result(std::move(data), a_); });
    }

    // ── Hook folds ──
    A<Value> run_filter_hooks(const RequestContext& ctx, const SchemaMeta& schema, Value where, KeymaAction action) {
        return seq_fold<Async>(plugins_.data(), plugins_.data() + plugins_.size(), std::move(where),
            [this, &ctx, &schema, action](Value acc, KeymaServerPlugin<Async>* p) -> A<Value> {
                if (!p->has_transform_filter()) return AT::ready(std::move(acc));
                return AT::then(p->transform_filter(ctx, schema, acc, action),
                    [acc = std::move(acc)](std::optional<Value> next) mutable {
                        return next.has_value() ? std::move(*next) : std::move(acc);
                    });
            });
    }
    A<AdapterProjection> run_projection_hooks(const RequestContext& ctx, const SchemaMeta& schema,
                                              AdapterProjection projection, KeymaAction action) {
        return seq_fold<Async>(plugins_.data(), plugins_.data() + plugins_.size(), std::move(projection),
            [this, &ctx, &schema, action](AdapterProjection acc, KeymaServerPlugin<Async>* p) -> A<AdapterProjection> {
                if (!p->has_transform_projection()) return AT::ready(std::move(acc));
                return AT::then(p->transform_projection(ctx, schema, acc, action),
                    [acc = std::move(acc)](std::optional<AdapterProjection> next) mutable {
                        return next.has_value() ? std::move(*next) : std::move(acc);
                    });
            });
    }
    A<Value> run_write_hooks(const RequestContext& ctx, const SchemaMeta& schema, Value data, KeymaWriteAction action) {
        return seq_fold<Async>(plugins_.data(), plugins_.data() + plugins_.size(), std::move(data),
            [this, &ctx, &schema, action](Value acc, KeymaServerPlugin<Async>* p) -> A<Value> {
                if (!p->has_check_write()) return AT::ready(std::move(acc));
                return AT::then(p->check_write(ctx, schema, acc, action),
                    [acc = std::move(acc)](std::optional<Value> next) mutable {
                        return next.has_value() ? std::move(*next) : std::move(acc);
                    });
            });
    }
    A<std::pmr::vector<Value>> run_result_hooks(const RequestContext& ctx, const SchemaMeta& schema,
                                                std::pmr::vector<Value> records, KeymaAction action) {
        return seq_fold<Async>(plugins_.data(), plugins_.data() + plugins_.size(), std::move(records),
            [this, &ctx, &schema, action](std::pmr::vector<Value> acc, KeymaServerPlugin<Async>* p)
                -> A<std::pmr::vector<Value>> {
                if (!p->has_transform_result()) return AT::ready(std::move(acc));
                return AT::then(p->transform_result(ctx, schema, acc, action),
                    [acc = std::move(acc)](std::optional<std::pmr::vector<Value>> next) mutable {
                        return next.has_value() ? std::move(*next) : std::move(acc);
                    });
            });
    }
    A<void> run_before_operation(const RequestContext& ctx, const Value& op) {
        return AT::then(
            seq_fold<Async>(plugins_.data(), plugins_.data() + plugins_.size(), std::monostate{},
                [this, &ctx, &op](std::monostate s, KeymaServerPlugin<Async>* p) -> A<std::monostate> {
                    if (!p->has_before_operation()) return AT::ready(s);
                    return AT::then(p->before_operation(ctx, op), [s]() { return s; });
                }),
            [](std::monostate) {});
    }

    // ── Projection builder (synchronous; port of buildAdapterProjection) ──
    AdapterProjection build_adapter_projection(const SchemaMeta& schema, const Value* spec, bool include_private) {
        AdapterProjection result(a_);
        Value fields = Value::object(a_);
        const EdgeMeta* edge = schema.edge;
        auto is_visible = [&](const FieldMeta& f) { return include_private || f.visibility != Visibility::Private; };
        auto find_field = [&](std::string_view key) -> const FieldMeta* {
            for (const FieldMeta& f : schema.fields) if (f.name == key) return &f;
            return nullptr;
        };

        auto handle_entry = [&](std::string_view key, const Value* sub) {
            const FieldMeta* field = find_field(key);
            const TypeTag core = (field != nullptr)
                ? ((field->type == TypeTag::Array) ? field->element : field->type)
                : TypeTag::String;

            if (edge != nullptr && (key == edge->from_field || key == edge->to_field)) {
                std::string_view target_name = (key == edge->from_field) ? edge->from : edge->to;
                const SchemaMeta* referenced = find_schema(target_name);
                if (referenced != nullptr) {
                    PopulateNode pn(a_);
                    pn.field = std::pmr::string(key, a_);
                    pn.schema = referenced;
                    if (sub == nullptr) {
                        pn.projection.fields = Value::object(a_);
                        pn.projection.fields.set("id", Value(std::int64_t{1}, a_));
                    } else {
                        pn.projection = with_id_field(build_adapter_projection(*referenced, sub, include_private));
                    }
                    result.populate.push_back(std::move(pn));
                    return;
                }
            }
            if (field != nullptr && core == TypeTag::Reference && sub != nullptr) {
                const SchemaMeta* referenced = find_schema(field->target);
                if (referenced != nullptr) {
                    PopulateNode pn(a_);
                    pn.field = std::pmr::string(key, a_);
                    pn.schema = referenced;
                    pn.projection = build_adapter_projection(*referenced, sub, include_private);
                    result.populate.push_back(std::move(pn));
                    return;
                }
            }
            if (field != nullptr && core == TypeTag::Embedded && sub != nullptr) {
                fields.set(key, build_embedded_spec(*sub));
                return;
            }
            fields.set(key, Value(std::int64_t{1}, a_));
        };

        if (spec != nullptr && spec->is_object()) {
            for (const Value::Member& m : spec->as_object()) {
                std::string_view key(m.key);
                const FieldMeta* field = find_field(key);
                if (field == nullptr || !is_visible(*field)) continue;
                const Value* sub = server_detail::is_one(m.value) ? nullptr : &m.value;
                handle_entry(key, sub);
            }
        } else {
            for (const FieldMeta& f : schema.fields) {
                if (!is_visible(f)) continue;
                handle_entry(f.name, nullptr);
            }
        }

        if (!fields.as_object().empty()) result.fields = std::move(fields);
        return result;
    }

    Value build_embedded_spec(const Value& spec) {
        Value out = Value::object(a_);
        if (spec.is_object()) {
            for (const Value::Member& m : spec.as_object()) {
                if (server_detail::is_one(m.value)) out.set(std::string_view(m.key), Value(std::int64_t{1}, a_));
                else out.set(std::string_view(m.key), build_embedded_spec(m.value));
            }
        }
        return out;
    }
    AdapterProjection with_id_field(AdapterProjection proj) {
        if (proj.fields.is_null()) proj.fields = Value::object(a_);
        proj.fields.set("id", Value(std::int64_t{1}, a_));
        return proj;
    }

    // ── Small helpers ──
    ListQuery make_list_query(const Value& op, Value where, AdapterProjection proj) {
        ListQuery q(a_);
        q.where = std::move(where);
        q.projection = std::move(proj);
        const Value* options = op.find("options");
        if (options != nullptr && options->is_object()) {
            const Value* sort = options->find("sort");
            if (sort != nullptr) q.sort = Value(*sort, a_);
            const Value* skip = options->find("skip");
            if (skip != nullptr && skip->is_number()) q.skip = skip->as_int();
            const Value* limit = options->find("limit");
            if (limit != nullptr && limit->is_number()) q.limit = limit->as_int();
        }
        if (q.sort.is_null()) q.sort = Value::object(a_);
        return q;
    }
    Value array_of(std::pmr::vector<Value> records) {
        Value arr = Value::array(a_);
        for (Value& v : records) arr.push(std::move(v));
        return arr;
    }
    static bool is_plain_record(const Value& v) {
        if (!v.is_object()) return false;
        return !(v.find("nodes") != nullptr && v.find("edges") != nullptr);
    }
    static bool all_plain_records(const Value& arr) {
        for (const Value& e : arr.as_array()) if (!is_plain_record(e)) return false;
        return true;
    }

    KeymaDatabaseAdapter<Async>* adapter_;
    alloc_t a_;
    std::pmr::vector<const SchemaMeta*> schemas_;
    std::pmr::vector<std::pair<std::string_view, const SchemaMeta*>> schema_map_;
    std::pmr::vector<KeymaServerPlugin<Async>*> plugins_;
    std::pmr::vector<std::pair<std::string_view, Service<Async>*>> service_map_;
    bool initialized_ = false;
};

}  // namespace keyma
