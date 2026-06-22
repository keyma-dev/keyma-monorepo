// Behavioral test for the @keyma/runtime-cpp consumer layer (server/client/json/
// serialize/validate) under the default synchronous policy (Async = keyma::Sync).
// Compiled and run by scripts/cpp-test.sh.
//
// The InMemoryAdapter, ScopePlugin, and the app::User model below are TEST SCAFFOLDING
// only — they are not part of the shipped runtime (which provides just the pure-virtual
// interfaces). They stand in for the database adapter / plugin / generated model so the
// server and client can be exercised end to end.

#include <keyma/client.hpp>
#include <keyma/json.hpp>
#include <keyma/serialize.hpp>
#include <keyma/server.hpp>

#include <cassert>
#include <format>
#include <memory_resource>
#include <span>
#include <string_view>

using namespace keyma;

// ─── Test-only in-memory adapter ────────────────────────────────────────────────────
struct InMemoryAdapter : KeymaDatabaseAdapter<> {
    std::pmr::monotonic_buffer_resource* pool;
    std::pmr::vector<std::pmr::string> names;
    std::pmr::vector<std::pmr::vector<Value>> store;
    long seq = 0;
    explicit InMemoryAdapter(std::pmr::monotonic_buffer_resource* p)
        : pool(p), names(alloc_t{p}), store(alloc_t{p}) {}
    alloc_t a() { return alloc_t{pool}; }

    std::pmr::vector<Value>* bucket(std::string_view n) {
        for (std::size_t i = 0; i < names.size(); ++i)
            if (names[i] == n) return &store[i];
        return nullptr;
    }
    static bool matches(const Value& rec, const Value& where) {
        if (!where.is_object()) return true;
        for (const Value::Member& m : where.as_object()) {
            const Value* fv = rec.find(m.key);
            if (m.value.is_object()) {  // operator object: $eq / $in / $ne
                if (const Value* eq = m.value.find("$eq")) { if (!fv || !(*fv == *eq)) return false; }
                if (const Value* ne = m.value.find("$ne")) { if (fv && (*fv == *ne)) return false; }
                if (const Value* in = m.value.find("$in"); in && in->is_array()) {
                    bool any = false;
                    if (fv) for (const Value& e : in->as_array()) if (*fv == e) { any = true; break; }
                    if (!any) return false;
                }
            } else {
                if (!fv || !(*fv == m.value)) return false;
            }
        }
        return true;
    }

    Sync<void> ensure_schema(const SchemaMeta& s) override {
        if (!bucket(s.name)) {
            names.push_back(std::pmr::string(s.name, a()));
            store.push_back(std::pmr::vector<Value>(a()));
        }
        return {};
    }
    Sync<Value> create(const SchemaMeta& s, Value data, AdapterProjection) override {
        if (data.find("id") == nullptr)
            data.set("id", to_value(std::pmr::string(std::format("{}-{}", s.name, ++seq), a()), a()));
        bucket(s.name)->push_back(Value(data, a()));
        return Sync<Value>{std::move(data)};
    }
    Sync<Value> read(const SchemaMeta& s, Value where, AdapterProjection) override {
        if (auto* b = bucket(s.name))
            for (const Value& r : *b) if (matches(r, where)) return Sync<Value>{Value(r, a())};
        return Sync<Value>{Value(nullptr, a())};
    }
    Sync<std::pmr::vector<Value>> list(const SchemaMeta& s, ListQuery q) override {
        std::pmr::vector<Value> out(a());
        if (auto* b = bucket(s.name))
            for (const Value& r : *b) if (matches(r, q.where)) out.push_back(Value(r, a()));
        return Sync<std::pmr::vector<Value>>{std::move(out)};
    }
    Sync<Value> update(const SchemaMeta& s, Value where, Value data, AdapterProjection) override {
        if (auto* b = bucket(s.name))
            for (Value& r : *b) if (matches(r, where)) {
                for (const Value::Member& m : data.as_object()) r.set(m.key, Value(m.value, a()));
                return Sync<Value>{Value(r, a())};
            }
        throw KeymaRuntimeError("NOT_FOUND", "not found");
    }
    Sync<void> del(const SchemaMeta& s, Value where) override {
        if (auto* b = bucket(s.name))
            for (std::size_t i = 0; i < b->size(); ++i)
                if (matches((*b)[i], where)) { b->erase(b->begin() + static_cast<long>(i)); break; }
        return {};
    }
    Sync<std::int64_t> count(const SchemaMeta& s, Value where) override {
        long n = 0;
        if (auto* b = bucket(s.name))
            for (const Value& r : *b) if (matches(r, where)) ++n;
        return Sync<std::int64_t>{n};
    }
};

// A test-only remotely-callable service.
struct MathService : Service<> {
    alloc_t a;
    explicit MathService(alloc_t alloc) : a(alloc) {}
    const ServiceMeta& meta() const override {
        static const ServiceParamMeta params[] = {{"a", ""}, {"b", ""}};
        static const ServiceMethodMeta methods[] = {{"add", Visibility::Public, std::span<const ServiceParamMeta>(params)}};
        static const ServiceMeta m{"math", Visibility::Public, std::span<const ServiceMethodMeta>(methods)};
        return m;
    }
    Sync<Value> dispatch(std::string_view method, const Value& args, const RequestContext&) override {
        if (method == "add")
            return Sync<Value>{Value(args.at("a").as_int() + args.at("b").as_int(), a)};
        throw KeymaRuntimeError("METHOD_NOT_IMPLEMENTED", "unknown method");
    }
};

// A plugin exercising transform_filter (scoping), check_write (stamping), and afterOperation.
struct ScopePlugin : KeymaServerPlugin<> {
    int* after_count;
    alloc_t a;
    ScopePlugin(int* c, alloc_t alloc) : after_count(c), a(alloc) {}
    std::string_view name() const override { return "scope"; }

    bool has_check_write() const override { return true; }
    Sync<std::optional<Value>> check_write(const RequestContext&, const SchemaMeta&, const Value& data,
                                           KeymaWriteAction) override {
        Value next(data, a);
        next.set("tenant", Value(std::string_view("acme"), a));
        return Sync<std::optional<Value>>{std::optional<Value>(std::move(next))};
    }
    bool has_after_operation() const override { return true; }
    Sync<void> after_operation(const RequestContext&, const Value&, const Value&) override {
        ++*after_count; return {};
    }
};

// ─── Test-only generated-style model ────────────────────────────────────────────────
namespace app {
struct User {
    using allocator_type = alloc_t;
    std::pmr::string id, name, role, tenant;
    User() = default;
    explicit User(const allocator_type& al) : id(al), name(al), role(al), tenant(al) {}
    User(const User& o, const allocator_type& al)
        : id(o.id, al), name(o.name, al), role(o.role, al), tenant(o.tenant, al) {}
    User(User&& o, const allocator_type& al)
        : id(std::move(o.id), al), name(std::move(o.name), al), role(std::move(o.role), al), tenant(std::move(o.tenant), al) {}
    User(const User&) = default;
    User(User&&) = default;
    User& operator=(const User&) = default;
    User& operator=(User&&) = default;
    allocator_type get_allocator() const noexcept { return id.get_allocator(); }
    static const SchemaMeta& schema();
};
}  // namespace app

template <>
struct keyma::value_traits<app::User> {
    using T = app::User;
    static T from_value(const Value& v, alloc_t a) {
        T o(a);
        if (v.is_object()) {
            o.id = keyma::from_value<std::pmr::string>(v.at("id"), a);
            o.name = keyma::from_value<std::pmr::string>(v.at("name"), a);
            o.role = keyma::from_value<std::pmr::string>(v.at("role"), a);
            o.tenant = keyma::from_value<std::pmr::string>(v.at("tenant"), a);
        }
        return o;
    }
    static Value to_value(const T& o, alloc_t a) {
        Value v = Value::object(a);
        v.set("id", keyma::to_value(o.id, a));
        v.set("name", keyma::to_value(o.name, a));
        v.set("role", keyma::to_value(o.role, a));
        v.set("tenant", keyma::to_value(o.tenant, a));
        return v;
    }
};

namespace app {
const SchemaMeta& User::schema() {
    static const ValidatorFn name_validators[] = {
        ValidatorFn([](const Value& v, std::string_view field, const Context&)
                        -> std::expected<void, ValidationError> {
            if (v.is_string() && v.as_string().size() >= 2) return {};
            return std::unexpected(ValidationError{std::pmr::string(field), std::pmr::string("minLength"),
                                                   std::pmr::string("must be at least 2 chars")});
        })};
    static const PhasedFormatter name_formatters[] = {
        PhasedFormatter{Phase::Save, FormatterFn([](const Value& v, const Context&) -> Value {
            alloc_t la{};
            return v.is_string() ? to_value(trim(v.as_string(), la), la) : Value(v, la);
        })}};
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id},
        FieldMeta{.name = "name", .type = TypeTag::String,
                  .validators = std::span<const ValidatorFn>(name_validators),
                  .formatters = std::span<const PhasedFormatter>(name_formatters)},
        FieldMeta{.name = "email", .type = TypeTag::String, .required = false, .visibility = Visibility::Private},
        FieldMeta{.name = "role", .type = TypeTag::String, .required = false},
        FieldMeta{.name = "tenant", .type = TypeTag::String, .required = false},
    };
    static const SchemaMeta m{.name = "user", .source_name = "User",
                              .fields = std::span<const FieldMeta>(fields),
                              .apply_defaults = +[](Value& d, const Value::allocator_type& a) {
                                  if (d.find("role") == nullptr) d.set("role", Value(std::string_view("member"), a));
                              }};
    return m;
}
}  // namespace app

// ─── Tests ──────────────────────────────────────────────────────────────────────────
static void test_json(alloc_t a) {
    Value v = json_parse(R"({"n":42,"pi":3.5,"ok":true,"x":null,"xs":[1,"two",3]})", a);
    assert(v.at("n").is_int() && v.at("n").as_int() == 42);
    assert(v.at("pi").is_double());
    assert(v.at("xs").as_array().size() == 3);
    std::pmr::string s = json_stringify(v, a);
    assert(json_parse(std::string_view(s), a) == v);  // round-trips

    bool threw = false;
    try { json_parse("{oops}", a); } catch (const KeymaRuntimeError& e) { threw = e.code() == "PARSE_ERROR"; }
    assert(threw);
}

static void test_server_and_client(alloc_t a) {
    const SchemaMeta* schemas[] = {&app::User::schema()};
    // The adapter keeps its own resource for the test's duration.
    static std::pmr::monotonic_buffer_resource adapter_pool;
    InMemoryAdapter mem(&adapter_pool);
    int after = 0;
    ScopePlugin plugin(&after, a);
    KeymaServerPlugin<>* plugins[] = {&plugin};
    MathService math(a);
    Service<>* services[] = {&math};

    KeymaServer<> server(KeymaServer<>::Options{
        .schemas = std::span<const SchemaMeta* const>(schemas),
        .adapter = &mem,
        .plugins = std::span<KeymaServerPlugin<>* const>(plugins),
        .services = std::span<Service<>* const>(services),
        .alloc = a,
    });
    sync_get(server.ensure_schemas());
    Transport<> tx = create_direct_transport(server);

    // typed create — Save-phase formatter trims the name, default role applied, plugin stamps tenant
    Value data = Value::object(a);
    data.set("name", Value(std::string_view("  Ada  "), a));
    data.set("email", Value(std::string_view("ada@x.io"), a));
    app::User created = sync_get(create_as<app::User>(tx, std::move(data), Value{}, a));
    assert(created.name == "Ada" && created.role == "member" && created.tenant == "acme");
    assert(!created.id.empty());

    // service call through the client
    Document<> call_doc(a);
    Value call_args = Value::object(a);
    call_args.set("a", Value(std::int64_t{2}, a));
    call_args.set("b", Value(std::int64_t{3}, a));
    call_doc.add("s", Keyma::call("math", "add", std::move(call_args), a));
    Value call_resp = sync_get(call_doc.request(tx));
    assert(proto::leaf_ok(call_resp.at("results").at("s")));
    assert(call_resp.at("results").at("s").at("data").as_int() == 5);

    // typed read
    Value where = Value::object(a);
    where.set("id", Value(std::string_view(created.id), a));
    auto got = sync_get(read_as<app::User>(tx, Value(where, a), Value{}, a));
    assert(got.has_value() && got->name == "Ada");

    // serialize client strips the private email field (server-side record carries it)
    Value srv_record = Value::object(a);
    srv_record.set("id", Value(std::string_view("u-1"), a));
    srv_record.set("name", Value(std::string_view("Ada"), a));
    srv_record.set("email", Value(std::string_view("ada@x.io"), a));
    Value client_view = serialize(app::User::schema(), srv_record, SerializeTarget::Client, a);
    assert(client_view.find("email") == nullptr && client_view.at("name").as_string() == "Ada");

    // typed update
    Value patch = Value::object(a);
    patch.set("role", Value(std::string_view("admin"), a));
    app::User updated = sync_get(update_as<app::User>(tx, Value(where, a), std::move(patch), Value{}, a));
    assert(updated.role == "admin");

    // validation failure surfaces as a structured leaf failure
    Value bad = Value::object(a);
    bad.set("name", Value(std::string_view("x"), a));
    bool threw = false;
    try { (void)sync_get(create_as<app::User>(tx, std::move(bad), Value{}, a)); }
    catch (const KeymaRuntimeError& e) { threw = e.code() == "VALIDATION_FAILED"; }
    assert(threw);

    // dynamic batched document with input substitution
    Document<> doc(a);
    Value by_id = Value::object(a);
    by_id.set("id", Keyma::input("uid", a));
    doc.add("one", Keyma::read("user", std::move(by_id), Value{}, a));
    doc.add("n", Keyma::count("user", Value{}, a));
    Value inputs = Value::object(a);
    Value one_inputs = Value::object(a);
    one_inputs.set("uid", Value(std::string_view(created.id), a));
    inputs.set("one", std::move(one_inputs));
    Value resp = sync_get(doc.request(tx, std::move(inputs)));
    assert(resp.at("results").at("one").at("data").at("name").as_string() == "Ada");
    assert(resp.at("results").at("n").at("data").as_int() == 1);

    // unknown schema is reported as a probing-resistant SCHEMA_NOT_FOUND failure
    Value ghost = sync_get(server.handle(
        proto::request([&] {
            Value ops = Value::object(a);
            ops.set("g", proto::read_op("ghost", where, Value{}, a));
            return ops;
        }(), a)));
    assert(proto::leaf_code(ghost.at("results").at("g")) == "SCHEMA_NOT_FOUND");

    // delete + count
    (void)sync_get(server.handle(proto::request([&] {
        Value ops = Value::object(a);
        ops.set("d", proto::delete_op("user", where, a));
        return ops;
    }(), a)));
    assert(sync_get(count_to(tx, "user", Value{}, a)) == 0);

    assert(after > 0);  // afterOperation fired
}

static void test_record_ops(alloc_t a) {
    // validate (drop id) flags the too-short name
    Value bad = Value::object(a);
    bad.set("name", Value(std::string_view("x"), a));
    auto errs = validate_if(app::User::schema(), bad, a, [](const FieldMeta& f) { return f.name != "id"; });
    bool minlen = false;
    for (const ValidationError& e : errs) if (e.code == "minLength") minlen = true;
    assert(minlen);

    // defaults fill the absent role
    Value d = Value::object(a);
    apply_defaults(app::User::schema(), d, a);
    assert(d.at("role").as_string() == "member");

    // normalize_reference_ids collapses an {id} reference to its bare id
    static const FieldMeta pf[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id},
        FieldMeta{.name = "author", .type = TypeTag::Reference, .required = false, .target = "user"},
    };
    static const SchemaMeta post{.name = "post", .source_name = "Post", .fields = std::span<const FieldMeta>(pf)};
    Value rec = Value::object(a);
    Value author = Value::object(a);
    author.set("id", Value(std::string_view("u-7"), a));
    author.set("name", Value(std::string_view("ignored"), a));
    rec.set("author", std::move(author));
    Value norm = normalize_reference_ids(rec, post, a);
    assert(norm.at("author").is_string() && norm.at("author").as_string() == "u-7");
}

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a{&pool};
    test_json(a);
    test_record_ops(a);
    test_server_and_client(a);
    return 0;
}
