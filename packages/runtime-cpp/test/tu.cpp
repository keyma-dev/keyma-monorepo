// A standalone translation unit that includes the umbrella runtime header and exercises the
// pieces generated code relies on (Value::push, the serialization entry points, the intrinsic
// helpers, AND the @Service RPC surface — task / service / transport / service_host / result /
// error — all reachable from `<keyma/runtime.hpp>` alone). Compiled with
// `-std=c++23 -Iinclude -fsyntax-only` by scripts/cpp-test.sh. Catches header rot at the source,
// independent of the backend.
#include <keyma/runtime.hpp>
#include <keyma/binary-typed.hpp>  // syntax-check the typed binary codec header standalone (re-include no-op)

#include <cassert>
#include <memory>
#include <memory_resource>
#include <optional>
#include <string_view>

namespace app {
// A tiny hand-written struct + value_traits specialization, mirroring what the C++
// backend emits, so the runtime's generic machinery is type-checked end to end.
// A fully allocator-aware struct, mirroring what the C++ backend emits (so std::pmr
// uses-allocator construction through std::allocate_shared works).
struct Point {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
    std::pmr::string id;
    std::int64_t x = 0;
    std::optional<std::pmr::string> label;

    Point() = default;
    explicit Point(const allocator_type& a) : id(a) {}
    Point(const Point& o, const allocator_type& a) : id(o.id, a), x(o.x), label(keyma::alloc_opt(o.label, a)) {}
    Point(Point&& o, const allocator_type& a) : id(std::move(o.id), a), x(o.x), label(keyma::alloc_opt(std::move(o.label), a)) {}
    Point(const Point&) = default;
    Point(Point&&) = default;
    Point& operator=(const Point&) = default;
    Point& operator=(Point&&) = default;
    allocator_type get_allocator() const noexcept { return id.get_allocator(); }
};
}  // namespace app

template <>
struct keyma::value_traits<app::Point> {
    using T = app::Point;
    static T from_value(const keyma::Value& v, keyma::alloc_t a) {
        T o(a);
        if (v.is_object()) {
            o.id = keyma::from_value<std::pmr::string>(v.at("id"), a);
            o.x = keyma::from_value<std::int64_t>(v.at("x"), a);
            o.label = keyma::from_value<std::optional<std::pmr::string>>(v.at("label"), a);
        }
        return o;
    }
    static keyma::Value to_value(const T& o, keyma::alloc_t a) {
        keyma::Value out = keyma::Value::object(a);
        out.set("id", keyma::to_value(o.id, a));
        out.set("x", keyma::to_value(o.x, a));
        out.set("label", keyma::to_value(o.label, a));
        return out;
    }
    static void set_id(T& t, const keyma::Value& idv, keyma::alloc_t a) {
        t.id = keyma::from_value<std::pmr::string>(idv, a);
    }
    static keyma::Value id_value(const T& t, keyma::alloc_t a) { return keyma::to_value(t.id, a); }
};

// The generated-service shape, syntax-checked: a service base deriving keyma::service (meta() +
// dispatch over the wire_payload envelope), a client returning keyma::task<keyma::result<T, error>>,
// and the host/transport seam — all reached through the umbrella header only. Never called; it only
// has to type-check (the umbrella exposes the full RPC surface generated headers depend on).
namespace shape {
struct DemoService : keyma::service {
    virtual keyma::task<std::int64_t> echo(std::int64_t n, const keyma::RequestContext& ctx) = 0;
    const keyma::service_meta& meta() const override {
        static const keyma::service_method_meta methods[] = {{"echo", keyma::Visibility::Public, {}}};
        static const keyma::service_meta m{"DemoService", keyma::Visibility::Public,
                                           std::span<const keyma::service_method_meta>(methods)};
        return m;
    }
    keyma::task<keyma::call_result> dispatch(std::string_view, const keyma::wire_payload&,
                                             const keyma::RequestContext&, keyma::encoding, keyma::alloc_t a) override {
        co_return keyma::call_result::success(keyma::wire_payload(keyma::Value(nullptr, a)));
    }
};
[[maybe_unused]] inline keyma::task<keyma::result<std::int64_t, keyma::error>> demo_client(keyma::transport& tx) {
    keyma::result<keyma::wire_payload, keyma::error> r =
        co_await keyma::client_invoke(tx, "DemoService", "echo", keyma::empty_payload(tx.wire_encoding()));
    if (!r.has_value()) co_return std::unexpected(r.error());
    co_return keyma::result<std::int64_t, keyma::error>(0);
}
[[maybe_unused]] inline void host_shape() {
    keyma::service_host host;
    keyma::direct_transport tx = keyma::create_direct_transport(host);
    (void)tx;
}
}  // namespace shape

int main() {
    std::pmr::monotonic_buffer_resource pool;
    keyma::Value::allocator_type a{&pool};

    // Value::push builds an array.
    keyma::Value arr = keyma::Value::array(a);
    arr.push(keyma::Value(std::int64_t{1}, a));
    arr.push(keyma::Value(std::int64_t{2}, a));
    assert(arr.as_array().size() == 2);

    // Scalar from_value.
    keyma::Value rec = keyma::Value::object(a);
    rec.set("id", keyma::Value(std::string_view{"p-1"}, a));
    rec.set("x", keyma::Value(std::int64_t{7}, a));
    app::Point p = keyma::from_value<app::Point>(rec, a);
    assert(p.id == "p-1" && p.x == 7 && !p.label.has_value());

    // Round-trip a struct → Value → struct, plus a vector and a reference id-stub.
    keyma::Value back = keyma::to_value<app::Point>(p, a);
    assert(back.at("id").as_string() == "p-1");

    auto pts = keyma::from_value<std::pmr::vector<app::Point>>(arr.is_array() ? keyma::Value::array(a) : arr, a);
    assert(pts.empty());

    keyma::Value idv = keyma::Value(std::string_view{"p-9"}, a);
    std::shared_ptr<app::Point> ref = keyma::from_value<std::shared_ptr<app::Point>>(idv, a);
    assert(ref && ref->id == "p-9");
    keyma::Value refback = keyma::to_value<std::shared_ptr<app::Point>>(ref, a);
    assert(refback.as_string() == "p-9");
    std::shared_ptr<app::Point> nullref = keyma::from_value<std::shared_ptr<app::Point>>(keyma::Value(nullptr, a), a);
    assert(!nullref);

    // Presence matrix: from_value_field distinguishes absent / present-null / present-value;
    // a single-axis optional collapses absent and present-null to nullopt.
    keyma::Value obj = keyma::Value::object(a);
    obj.set("nullk", keyma::Value(nullptr, a));
    obj.set("valk", keyma::Value(std::string_view{"v"}, a));
    auto f_null = keyma::from_value_field<std::pmr::string>(obj.find("nullk"), a);
    assert(f_null.present && f_null.is_null());
    auto f_absent = keyma::from_value_field<std::pmr::string>(obj.find("missing"), a);
    assert(f_absent.is_absent());
    auto f_val = keyma::from_value_field<std::pmr::string>(obj.find("valk"), a);
    assert(f_val.present && !f_val.is_null() && f_val.get() == "v");
    auto opt_null = keyma::from_value<std::optional<std::pmr::string>>(obj.at("nullk"), a);
    assert(!opt_null.has_value());

    // mod: integral uses %, any floating operand uses fmod.
    assert(keyma::mod(7, 3) == 1);
    assert(keyma::mod(5.0, 2.0) == 1.0);
    assert(keyma::mod(0.5, 0.5) == 0.0);
    assert(keyma::mod(2.5, 1) == 0.5);

    // filter: arity-adaptive predicate (element, or element + index).
    std::pmr::vector<std::int64_t> nums(a);
    nums.push_back(1); nums.push_back(2); nums.push_back(3); nums.push_back(4);
    auto evens = keyma::filter(nums, [](auto n) { return n % 2 == 0; }, a);
    assert(evens.size() == 2);
    auto firstTwo = keyma::filter(nums, [](auto, std::int64_t i) { return i < 2; }, a);
    assert(firstTwo.size() == 2);

    // replace with a function replacer (the titleCase formatter pattern).
    auto titled = keyma::replace(std::string_view{"hello world"}, keyma::make_regex("\\b\\w", "g"),
                                 [&](std::pmr::string c) { return keyma::to_upper(c, a); }, a);
    assert(titled == "Hello World");

    // Value null comparison (the `value != null` guard).
    assert((keyma::Value(nullptr, a) == nullptr));
    assert(keyma::Value(std::int64_t{1}, a) != nullptr);

    (void) keyma::trim(std::string_view{"  hi "}, a);
    return 0;
}
