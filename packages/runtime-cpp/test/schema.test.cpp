// validate / format / apply_defaults drivers over the metadata-driven model (mirror of the JS
// validate/format/defaults tests). Compiled + run by scripts/cpp-test.sh. Constructs ClassMetadata
// with live ValidatorFn / PhasedFormatter callables and a base chain — the same shape the C++
// backend emits — and asserts the generic drivers' behavior, including inheritance (base-chain
// walk) and the parent-first apply_defaults order.
#include <keyma/runtime.hpp>

#include <cassert>
#include <cctype>
#include <expected>
#include <memory_resource>
#include <span>
#include <string>
#include <string_view>
#include <vector>

using namespace keyma;

// ── Inheritance fixtures (function-pointer `base`/`apply_defaults`, exactly as the backend emits) ──

static const ClassMetadata& base_meta() {
    static const FieldMeta fields[] = {
        FieldMeta{ .name = "name", .type = TypeTag::String, .required = true },
    };
    static const ClassMetadata m{
        .name = "Base", .source_name = "Base",
        .fields = std::span<const FieldMeta>(fields),
    };
    return m;
}

static void base_defaults(Value& data, const Value::allocator_type& a) {
    if (data.find("kind") == nullptr) data.set("kind", Value(std::string_view("node"), a));
}
static void leaf_defaults(Value& data, const Value::allocator_type& a) {
    if (data.find("status") == nullptr) data.set("status", Value(std::string_view("active"), a));
}
static const ClassMetadata& dbase_meta() {
    static const ClassMetadata m{ .name = "DBase", .source_name = "DBase", .apply_defaults = &base_defaults };
    return m;
}

static std::vector<std::string> g_order;
static void base_defaults_order(Value&, const Value::allocator_type&) { g_order.push_back("base"); }
static void leaf_defaults_order(Value&, const Value::allocator_type&) { g_order.push_back("leaf"); }
static const ClassMetadata& obase_meta() {
    static const ClassMetadata m{ .name = "OBase", .source_name = "OBase", .apply_defaults = &base_defaults_order };
    return m;
}

// ── Tests ──

static void test_validate(alloc_t a) {
    ValidatorFn isEven = [](const Value& v, std::string_view name, const Context&)
        -> std::expected<void, ValidationError> {
        if (v.is_number() && v.as_int() % 2 == 0) return {};
        return std::unexpected(ValidationError{
            std::pmr::string(name), std::pmr::string(std::string_view("isEven")),
            std::pmr::string(std::string_view("must be even")) });
    };
    std::vector<ValidatorFn> nVals;
    nVals.push_back(std::move(isEven));
    FieldMeta nFields[] = {
        FieldMeta{ .name = "n", .type = TypeTag::Number, .required = false,
                   .validators = std::span<const ValidatorFn>(nVals) },
    };
    ClassMetadata s{ .name = "T", .source_name = "T", .fields = std::span<const FieldMeta>(nFields) };

    Value bad = Value::object(a);
    bad.set("n", Value(std::int64_t{3}, a));
    auto e1 = validate(s, bad, a);
    assert(e1.size() == 1 && e1[0].code == "isEven");

    Value good = Value::object(a);
    good.set("n", Value(std::int64_t{4}, a));
    assert(validate(s, good, a).empty());

    // A missing required field fails with code "required".
    FieldMeta idF[] = { FieldMeta{ .name = "id", .type = TypeTag::Id } };  // required defaults to true
    ClassMetadata sid{ .name = "T", .source_name = "T", .fields = std::span<const FieldMeta>(idF) };
    Value empty = Value::object(a);
    auto er = validate(sid, empty, a);
    assert(er.size() == 1 && er[0].code == "required" && er[0].field == "id");

    // A missing optional field is skipped.
    assert(validate(s, empty, a).empty());

    // Inheritance: validate walks the base chain (required on inherited "name" + validator on
    // leaf "nick"), reported base-first.
    std::vector<ValidatorFn> nickVals;
    nickVals.push_back([](const Value& v, std::string_view name, const Context&)
        -> std::expected<void, ValidationError> {
        if (v.is_string() && v.as_string().size() >= 2) return {};
        return std::unexpected(ValidationError{
            std::pmr::string(name), std::pmr::string(std::string_view("minLength")),
            std::pmr::string(std::string_view("")) });
    });
    FieldMeta leafF[] = {
        FieldMeta{ .name = "nick", .type = TypeTag::String, .required = false,
                   .validators = std::span<const ValidatorFn>(nickVals) },
    };
    ClassMetadata leaf{ .name = "Leaf", .source_name = "Leaf",
                        .fields = std::span<const FieldMeta>(leafF), .base = &base_meta };
    Value v = Value::object(a);
    v.set("nick", Value(std::string_view("x"), a));  // "name" absent, "nick" too short
    auto e = validate(leaf, v, a);
    assert(e.size() == 2);
    assert(e[0].code == "required" && e[0].field == "name");
    assert(e[1].code == "minLength" && e[1].field == "nick");
}

static void test_format(alloc_t a) {
    FormatterFn upper = [a](const Value& v, const Context&) -> Value {
        if (!v.is_string()) return Value(v, a);
        std::pmr::string s(v.as_string(), a);
        for (auto& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        return Value(std::string_view(s), a);
    };
    FormatterFn lower = [a](const Value& v, const Context&) -> Value {
        if (!v.is_string()) return Value(v, a);
        std::pmr::string s(v.as_string(), a);
        for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return Value(std::string_view(s), a);
    };
    std::vector<PhasedFormatter> vf;
    vf.push_back(PhasedFormatter{ Phase::Save, std::move(lower) });
    vf.push_back(PhasedFormatter{ Phase::Change, std::move(upper) });
    FieldMeta f[] = {
        FieldMeta{ .name = "v", .type = TypeTag::String, .required = false,
                   .formatters = std::span<const PhasedFormatter>(vf) },
    };
    ClassMetadata s{ .name = "T", .source_name = "T", .fields = std::span<const FieldMeta>(f) };

    Value v1 = Value::object(a);
    v1.set("v", Value(std::string_view("AbC"), a));
    format(s, v1, Phase::Save);
    assert(v1.at("v").as_string() == "abc");

    Value v2 = Value::object(a);
    v2.set("v", Value(std::string_view("AbC"), a));
    format(s, v2, Phase::Change);
    assert(v2.at("v").as_string() == "ABC");

    // Absent values are skipped.
    Value v3 = Value::object(a);
    format(s, v3, Phase::Save);
    assert(v3.find("v") == nullptr);
}

static void test_defaults(alloc_t a) {
    ClassMetadata leaf{ .name = "DLeaf", .source_name = "DLeaf",
                        .base = &dbase_meta, .apply_defaults = &leaf_defaults };

    Value data = Value::object(a);
    apply_defaults(leaf, data, a);
    assert(data.at("kind").as_string() == "node");      // filled by base
    assert(data.at("status").as_string() == "active");  // filled by leaf

    // A present key is not overwritten.
    Value data2 = Value::object(a);
    data2.set("kind", Value(std::string_view("edge"), a));
    apply_defaults(leaf, data2, a);
    assert(data2.at("kind").as_string() == "edge");

    // Parent-first apply_defaults order.
    g_order.clear();
    ClassMetadata leafO{ .name = "OLeaf", .source_name = "OLeaf",
                         .base = &obase_meta, .apply_defaults = &leaf_defaults_order };
    Value d3 = Value::object(a);
    apply_defaults(leafO, d3, a);
    assert(g_order.size() == 2 && g_order[0] == "base" && g_order[1] == "leaf");
}

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a{&pool};
    test_validate(a);
    test_format(a);
    test_defaults(a);
    return 0;
}
