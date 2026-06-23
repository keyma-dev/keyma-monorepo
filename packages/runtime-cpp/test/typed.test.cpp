// Typed client-layer test for @keyma/runtime-cpp: concepts (keyma/concepts.hpp), typed
// leaves + send hydration (keyma/client.hpp), and the typed Where<T> / project<T> DSL
// (keyma/query.hpp). Compiled and run by scripts/cpp-test.sh.
//
// The app::Tag / app::User models below are TEST SCAFFOLDING that hand-write exactly what
// the C++ backend's emitStruct emits (value_traits<T>, schema(), and the nested `struct f`
// of typed field descriptors) so the runtime DSL can be exercised without the generator.

#include <keyma/client.hpp>
#include <keyma/json.hpp>
#include <keyma/query.hpp>
#include <keyma/server.hpp>

#include <cassert>
#include <memory_resource>
#include <optional>
#include <span>
#include <string_view>

using namespace keyma;

// ─── A named enum (mirrors emit-enum.ts output) ───────────────────────────────────────
namespace app {
enum class Status { Active, Inactive };
}
template <> inline std::string_view keyma::to_string<app::Status>(app::Status s) {
    return s == app::Status::Active ? "active" : "inactive";
}
template <> inline app::Status keyma::from_string<app::Status>(std::string_view s) {
    return s == "active" ? app::Status::Active : app::Status::Inactive;
}
template <> struct keyma::value_traits<app::Status> {
    static app::Status from_value(const Value& v, alloc_t) {
        return v.is_string() ? keyma::from_string<app::Status>(v.as_string()) : app::Status::Active;
    }
    static Value to_value(app::Status s, alloc_t a) { return Value(keyma::to_string(s), a); }
};

// ─── A reference-target model (mirrors a generated struct + value_traits + descriptors) ─
namespace app {
struct Tag {
    using allocator_type = alloc_t;
    std::pmr::string id, label;
    Tag() = default;
    explicit Tag(const allocator_type& al) : id(al), label(al) {}
    Tag(const Tag& o, const allocator_type& al) : id(o.id, al), label(o.label, al) {}
    Tag(Tag&& o, const allocator_type& al) : id(std::move(o.id), al), label(std::move(o.label), al) {}
    Tag(const Tag&) = default;
    Tag(Tag&&) = default;
    Tag& operator=(const Tag&) = default;
    Tag& operator=(Tag&&) = default;
    allocator_type get_allocator() const noexcept { return id.get_allocator(); }
    static const SchemaMeta& schema();
    struct f {
        struct id_ { using Owner = Tag; using Value = std::pmr::string; using RefTarget = void;
                     static constexpr std::string_view key() { return "id"; }
                     static constexpr keyma::FieldKind kind = keyma::FieldKind::Ordered; };
        struct label_ { using Owner = Tag; using Value = std::pmr::string; using RefTarget = void;
                        static constexpr std::string_view key() { return "label"; }
                        static constexpr keyma::FieldKind kind = keyma::FieldKind::Ordered; };
        static constexpr id_ id{};
        static constexpr label_ label{};
    };
};
}  // namespace app

template <> struct keyma::value_traits<app::Tag> {
    using T = app::Tag;
    static T from_value(const Value& v, alloc_t a) {
        T o(a);
        if (v.is_object()) {
            o.id = keyma::from_value<std::pmr::string>(v.at("id"), a);
            o.label = keyma::from_value<std::pmr::string>(v.at("label"), a);
        }
        return o;
    }
    static Value to_value(const T& o, alloc_t a) {
        Value v = Value::object(a);
        v.set("id", keyma::to_value(o.id, a));
        v.set("label", keyma::to_value(o.label, a));
        return v;
    }
    static void set_id(T& t, const Value& idv, alloc_t a) { t.id = keyma::from_value<std::pmr::string>(idv, a); }
    static Value id_value(const T& x, alloc_t a) { return keyma::to_value(x.id, a); }
};

namespace app {
const SchemaMeta& Tag::schema() {
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id},
        FieldMeta{.name = "label", .type = TypeTag::String},
    };
    static const SchemaMeta m{.name = "tag", .source_name = "Tag", .fields = std::span<const FieldMeta>(fields)};
    return m;
}
}  // namespace app

// ─── The main model: scalars, an enum, and a reference ────────────────────────────────
namespace app {
struct User {
    using allocator_type = alloc_t;
    std::pmr::string id, name;
    std::int64_t age = 0;
    Status status = Status::Active;
    std::shared_ptr<Tag> primaryTag;
    User() = default;
    explicit User(const allocator_type& al) : id(al), name(al) {}
    User(const User& o, const allocator_type& al)
        : id(o.id, al), name(o.name, al), age(o.age), status(o.status), primaryTag(o.primaryTag) {}
    User(User&& o, const allocator_type& al)
        : id(std::move(o.id), al), name(std::move(o.name), al), age(o.age), status(o.status),
          primaryTag(std::move(o.primaryTag)) {}
    User(const User&) = default;
    User(User&&) = default;
    User& operator=(const User&) = default;
    User& operator=(User&&) = default;
    allocator_type get_allocator() const noexcept { return id.get_allocator(); }
    static const SchemaMeta& schema();
    struct f {
        struct id_ { using Owner = User; using Value = std::pmr::string; using RefTarget = void;
                     static constexpr std::string_view key() { return "id"; }
                     static constexpr keyma::FieldKind kind = keyma::FieldKind::Ordered; };
        struct name_ { using Owner = User; using Value = std::pmr::string; using RefTarget = void;
                       static constexpr std::string_view key() { return "name"; }
                       static constexpr keyma::FieldKind kind = keyma::FieldKind::Ordered; };
        struct age_ { using Owner = User; using Value = std::int64_t; using RefTarget = void;
                      static constexpr std::string_view key() { return "age"; }
                      static constexpr keyma::FieldKind kind = keyma::FieldKind::Ordered; };
        struct status_ { using Owner = User; using Value = Status; using RefTarget = void;
                         static constexpr std::string_view key() { return "status"; }
                         static constexpr keyma::FieldKind kind = keyma::FieldKind::Enum; };
        struct primaryTag_ { using Owner = User; using Value = std::pmr::string; using RefTarget = Tag;
                             static constexpr std::string_view key() { return "primaryTag"; }
                             static constexpr keyma::FieldKind kind = keyma::FieldKind::Reference; };
        static constexpr id_ id{};
        static constexpr name_ name{};
        static constexpr age_ age{};
        static constexpr status_ status{};
        static constexpr primaryTag_ primaryTag{};
    };
};
}  // namespace app

template <> struct keyma::value_traits<app::User> {
    using T = app::User;
    static T from_value(const Value& v, alloc_t a) {
        T o(a);
        if (v.is_object()) {
            o.id = keyma::from_value<std::pmr::string>(v.at("id"), a);
            o.name = keyma::from_value<std::pmr::string>(v.at("name"), a);
            o.age = keyma::from_value<std::int64_t>(v.at("age"), a);
            o.status = keyma::from_value<app::Status>(v.at("status"), a);
            o.primaryTag = keyma::from_value<std::shared_ptr<app::Tag>>(v.at("primaryTag"), a);
        }
        return o;
    }
    static Value to_value(const T& o, alloc_t a) {
        Value v = Value::object(a);
        v.set("id", keyma::to_value(o.id, a));
        v.set("name", keyma::to_value(o.name, a));
        v.set("age", keyma::to_value(o.age, a));
        v.set("status", keyma::to_value(o.status, a));
        v.set("primaryTag", keyma::to_value(o.primaryTag, a));
        return v;
    }
};

namespace app {
const SchemaMeta& User::schema() {
    static const std::pair<std::string_view, const SchemaMeta& (*)()> refs[] = {{"tag", &Tag::schema}};
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id},
        FieldMeta{.name = "name", .type = TypeTag::String},
        FieldMeta{.name = "age", .type = TypeTag::Integer, .required = false},
        FieldMeta{.name = "status", .type = TypeTag::Enum, .required = false},
        FieldMeta{.name = "primaryTag", .type = TypeTag::Reference, .required = false, .target = "tag"},
    };
    static const SchemaMeta m{.name = "user", .source_name = "User",
                              .fields = std::span<const FieldMeta>(fields),
                              .refs = std::span<const std::pair<std::string_view, const SchemaMeta& (*)()>>(refs)};
    return m;
}
}  // namespace app

// ─── Minimal in-memory adapter (test scaffolding) ─────────────────────────────────────
struct MemAdapter : KeymaDatabaseAdapter<> {
    std::pmr::monotonic_buffer_resource* pool;
    std::pmr::vector<std::pmr::string> names;
    std::pmr::vector<std::pmr::vector<Value>> store;
    long seq = 0;
    explicit MemAdapter(std::pmr::monotonic_buffer_resource* p) : pool(p), names(alloc_t{p}), store(alloc_t{p}) {}
    alloc_t a() { return alloc_t{pool}; }
    std::pmr::vector<Value>* bucket(std::string_view n) {
        for (std::size_t i = 0; i < names.size(); ++i) if (names[i] == n) return &store[i];
        return nullptr;
    }
    static bool matches(const Value& rec, const Value& where) {
        if (!where.is_object()) return true;
        for (const Value::Member& m : where.as_object()) {
            const Value* fv = rec.find(m.key);
            if (m.value.is_object()) {
                if (const Value* eq = m.value.find("$eq")) { if (!fv || !(*fv == *eq)) return false; }
                if (const Value* in = m.value.find("$in"); in && in->is_array()) {
                    bool any = false;
                    if (fv) for (const Value& e : in->as_array()) if (*fv == e) { any = true; break; }
                    if (!any) return false;
                }
            } else if (!fv || !(*fv == m.value)) return false;
        }
        return true;
    }
    Sync<void> ensure_schema(const SchemaMeta& s) override {
        if (!bucket(s.name)) { names.push_back(std::pmr::string(s.name, a())); store.push_back(std::pmr::vector<Value>(a())); }
        return {};
    }
    Sync<Value> create(const SchemaMeta& s, Value data, AdapterProjection) override {
        if (data.find("id") == nullptr)
            data.set("id", to_value(std::pmr::string(std::string_view("u-1"), a()), a()));
        bucket(s.name)->push_back(Value(data, a()));
        return Sync<Value>{std::move(data)};
    }
    Sync<Value> read(const SchemaMeta& s, Value where, AdapterProjection) override {
        if (auto* b = bucket(s.name)) for (const Value& r : *b) if (matches(r, where)) return Sync<Value>{Value(r, a())};
        return Sync<Value>{Value(nullptr, a())};
    }
    Sync<std::pmr::vector<Value>> list(const SchemaMeta& s, ListQuery q) override {
        std::pmr::vector<Value> out(a());
        if (auto* b = bucket(s.name)) for (const Value& r : *b) if (matches(r, q.where)) out.push_back(Value(r, a()));
        return Sync<std::pmr::vector<Value>>{std::move(out)};
    }
    Sync<Value> update(const SchemaMeta& s, Value where, Value data, AdapterProjection) override {
        if (auto* b = bucket(s.name)) for (Value& r : *b) if (matches(r, where)) {
            for (const Value::Member& m : data.as_object()) r.set(m.key, Value(m.value, a()));
            return Sync<Value>{Value(r, a())};
        }
        throw KeymaRuntimeError("NOT_FOUND", "not found");
    }
    Sync<void> del(const SchemaMeta& s, Value where) override {
        if (auto* b = bucket(s.name)) for (std::size_t i = 0; i < b->size(); ++i)
            if (matches((*b)[i], where)) { b->erase(b->begin() + static_cast<long>(i)); break; }
        return {};
    }
    Sync<std::int64_t> count(const SchemaMeta& s, Value where) override {
        long n = 0;
        if (auto* b = bucket(s.name)) for (const Value& r : *b) if (matches(r, where)) ++n;
        return Sync<std::int64_t>{n};
    }
};

// A test-only remotely-callable service (exercises the typed Call leaf path).
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
        if (method == "add") return Sync<Value>{Value(args.at("a").as_int() + args.at("b").as_int(), a)};
        throw KeymaRuntimeError("METHOD_NOT_IMPLEMENTED", "unknown method");
    }
};

// ─── Compile-time guarantees (concepts) ───────────────────────────────────────────────
static_assert(KeymaRecord<app::User>);
static_assert(KeymaRecord<app::Tag>);
static_assert(Serializable<app::Status>);
static_assert(!KeymaRecord<int>);
static_assert(AsyncPolicy<Sync>);
static_assert(FieldDescriptor<app::User::f::age_>);
static_assert(FieldOf<app::User::f::age_, app::User>);
static_assert(!FieldOf<app::User::f::age_, app::Tag>);

// Detection helpers: wrapping a call in a named concept makes a constraint-failed call
// resolve to "unsatisfied" cleanly (a direct `!requires{ call() }` is a hard error in
// some compilers when the failing candidate is the only one).
template <class D, class A> concept CanEq = requires(D d, A a) { keyma::eq(d, a); };
template <class D, class A> concept CanGt = requires(D d, A a) { keyma::gt(d, a); };
template <class W, class P> concept CanAdd = requires(W& w, P p) { w.add(p); };

static_assert(CanEq<app::User::f::name_, const char*>);   // string field accepts a string
static_assert(CanEq<app::User::f::age_, int>);            // int field accepts an int
static_assert(!CanEq<app::User::f::age_, const char*>);   // ...but not a string
static_assert(CanGt<app::User::f::age_, int>);            // age is ordered → relational ok
// a predicate over a Tag field cannot be added to a Where<User>:
static_assert(!CanAdd<Where<app::User>, FieldPredicate<app::Tag::f::id_, std::pmr::string>>);
static_assert(CanAdd<Where<app::User>, FieldPredicate<app::User::f::id_, std::pmr::string>>);
// referencing a field that does not exist on the schema does not compile:
template <class T> concept HasNopeField = requires { T::f::nope; };
static_assert(!HasNopeField<app::User>);
static_assert(requires { app::User::f::age; });

// ─── Where / project lowering parity ──────────────────────────────────────────────────
static void test_where_lowering(alloc_t a) {
    // bare equality { id: "u-1" } matches the raw form
    {
        Value typed = where<app::User>(a, field(app::User::f::id, "u-1")).to_value(a);
        Value raw = Value::object(a);
        raw.set("id", Value(std::string_view("u-1"), a));
        assert(typed == raw);
    }
    // merged range { age: { $gte: 18, $lt: 65 } }
    {
        Value typed = where<app::User>(a, gte(app::User::f::age, 18), lt(app::User::f::age, 65)).to_value(a);
        Value op = Value::object(a);
        op.set("$gte", Value(std::int64_t{18}, a));
        op.set("$lt", Value(std::int64_t{65}, a));
        Value raw = Value::object(a);
        raw.set("age", std::move(op));
        assert(typed == raw);
    }
    // enum lowers to its wire string { status: { $eq: "active" } }
    {
        Value typed = where<app::User>(a, eq(app::User::f::status, app::Status::Active)).to_value(a);
        Value op = Value::object(a);
        op.set("$eq", Value(std::string_view("active"), a));
        Value raw = Value::object(a);
        raw.set("status", std::move(op));
        assert(typed == raw);
    }
    // in() over names { name: { $in: ["a", "b"] } }
    {
        Value typed = where<app::User>(a, in(app::User::f::name, "a", "b")).to_value(a);
        Value arr = Value::array(a);
        arr.push(Value(std::string_view("a"), a));
        arr.push(Value(std::string_view("b"), a));
        Value op = Value::object(a);
        op.set("$in", std::move(arr));
        Value raw = Value::object(a);
        raw.set("name", std::move(op));
        assert(typed == raw);
    }
    // reference accepts a bare id and an {id} wrapper; both produce the operator object
    {
        Value bare = where<app::User>(a, eq(app::User::f::primaryTag, "t-1")).to_value(a);
        assert(bare.at("primaryTag").at("$eq").as_string() == "t-1");
        Value wrapped = where<app::User>(a, eq(app::User::f::primaryTag, Ref{std::pmr::string("t-2", a)})).to_value(a);
        assert(wrapped.at("primaryTag").at("$eq").at("id").as_string() == "t-2");
    }
    // a typed input placeholder lowers to the {"$keyma_input": name} sentinel
    {
        Value typed = where<app::User>(a, eq(app::User::f::id, input<std::pmr::string>("uid"))).to_value(a);
        assert(typed.at("id").at("$eq").at("$keyma_input").as_string() == "uid");
    }
    // logical OR of two sub-Wheres
    {
        Value typed = or_<app::User>(a,
            where<app::User>(a, field(app::User::f::name, "Ada")),
            where<app::User>(a, gte(app::User::f::age, 21))).to_value(a);
        const Value& arr = typed.at("$or");
        assert(arr.is_array() && arr.as_array().size() == 2);
        assert(arr.as_array()[0].at("name").as_string() == "Ada");
        assert(arr.as_array()[1].at("age").at("$gte").as_int() == 21);
    }
    // project lowers to { id: 1, name: 1 }
    {
        Value typed = project<app::User>(a, app::User::f::id, app::User::f::name);
        Value raw = Value::object(a);
        raw.set("id", Value(std::int64_t{1}, a));
        raw.set("name", Value(std::int64_t{1}, a));
        assert(typed == raw);
    }
}

// ─── End-to-end through send() with typed leaves ──────────────────────────────────────
static void test_send(alloc_t a) {
    const SchemaMeta* schemas[] = {&app::User::schema(), &app::Tag::schema()};
    static std::pmr::monotonic_buffer_resource adapter_pool;
    MemAdapter mem(&adapter_pool);
    MathService math(a);
    Service<>* services[] = {&math};
    KeymaServer<> server(KeymaServer<>::Options{
        .schemas = std::span<const SchemaMeta* const>(schemas),
        .adapter = &mem,
        .services = std::span<Service<>* const>(services),
        .alloc = a,
    });
    sync_get(server.ensure_schemas());
    Transport<> tx = create_direct_transport(server);

    // typed create — result hydrates to app::User without re-specifying <T>
    Value data = Value::object(a);
    data.set("name", Value(std::string_view("Ada"), a));
    data.set("age", Value(std::int64_t{30}, a));
    data.set("status", Value(std::string_view("active"), a));
    app::User created = sync_get(send(tx, Keyma::create<app::User>(std::move(data), {}, a), {}, a));
    assert(created.name == "Ada" && created.age == 30 && created.status == app::Status::Active);
    assert(!created.id.empty());

    // typed read via a typed Where<T> → std::optional<app::User>
    auto got = sync_get(send(tx, Keyma::read<app::User>(where<app::User>(a, field(app::User::f::id, created.id)), {}, a), {}, a));
    assert(got.has_value() && got->name == "Ada");

    // typed list via Where<T> → std::pmr::vector<app::User>
    auto adults = sync_get(send(tx, Keyma::list<app::User>(where<app::User>(a, gte(app::User::f::age, 18)), {}, a), {}, a));
    assert(adults.size() == 1 && adults[0].name == "Ada");

    // typed count → std::int64_t
    std::int64_t n = sync_get(send(tx, Keyma::count<app::User>(where<app::User>(a, eq(app::User::f::name, "Ada")), a), {}, a));
    assert(n == 1);

    // typed service call via a CallLeaf<T> → hydrates the scalar return (mirrors a stub)
    Value call_args = Value::object(a);
    call_args.set("a", Value(std::int64_t{2}, a));
    call_args.set("b", Value(std::int64_t{3}, a));
    std::int64_t sum = sync_get(send(tx,
        CallLeaf<std::int64_t>{Keyma::call("math", "add", std::move(call_args), a)}, {}, a));
    assert(sum == 5);

    // typed delete → void, then count drops to zero
    sync_get(send(tx, Keyma::del<app::User>(where<app::User>(a, field(app::User::f::id, created.id)), a), {}, a));
    assert(sync_get(send(tx, Keyma::count<app::User>(Value{}, a), {}, a)) == 0);
}

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a{&pool};
    test_where_lowering(a);
    test_send(a);
    return 0;
}
