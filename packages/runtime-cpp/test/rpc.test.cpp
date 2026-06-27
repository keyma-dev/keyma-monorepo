// End-to-end @Service RPC over @keyma/runtime-cpp. Hand-writes a service + client in EXACTLY the
// shape the C++ backend emits (a generated `service` base with meta() + dispatch() switch handling
// BOTH encodings, and a typed per-service client bound to a transport returning
// task<result<T, error>>), then drives calls over every transport:
//   * direct_transport (inline, no event_loop) — gating (non-system vs system) + ctx injection,
//     in BOTH json and binary encoding;
//   * a JSON loopback transport (json.hpp, string wire round-trip);
//   * a genuinely-suspending transport driven on an event_loop.
// Compiled and run by scripts/cpp-test.sh (and the coroutine paths additionally under ASan).

#include <keyma/runtime.hpp>

#include <cassert>
#include <memory_resource>
#include <span>
#include <string_view>

using namespace keyma;

// ── A model struct + value_traits + binary_traits (what the C++ model backend emits). ──
namespace app {
struct Point {
    using allocator_type = alloc_t;
    std::int64_t x = 0, y = 0;
    Point() = default;
    explicit Point(const allocator_type&) {}
    Point(const Point&, const allocator_type&) {}
    Point(const Point&) = default;
    Point& operator=(const Point&) = default;
};
}  // namespace app

template <>
struct keyma::value_traits<app::Point> {
    using T = app::Point;
    static T from_value(const Value& v, alloc_t) {
        T o;
        if (v.is_object()) { o.x = v.at("x").as_int(); o.y = v.at("y").as_int(); }
        return o;
    }
    static Value to_value(const T& o, alloc_t a) {
        Value v = Value::object(a);
        v.set("x", Value(o.x, a));
        v.set("y", Value(o.y, a));
        return v;
    }
};

// Typed binary codec for the struct (length-windowed record, tags 1/2), mirroring the codegen'd
// binary_traits<T> specialization. Provides encode_payload / decode_payload + wiretype so the
// positional RPC marshaller can route a class-typed arg through it.
template <>
struct keyma::binary_traits<app::Point> {
    using T = app::Point;
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_LENGTH;
    static void encode_record(ByteBuf& out, const T& o, alloc_t) {
        binary_detail::write_key(out, 1, binary_detail::WIRE_VARINT);
        binary_detail::write_varint(out, binary_detail::zigzag_encode(o.x));
        binary_detail::write_key(out, 2, binary_detail::WIRE_VARINT);
        binary_detail::write_varint(out, binary_detail::zigzag_encode(o.y));
    }
    static T decode_record(binary_detail::Reader& r, alloc_t) {
        T o;
        while (r.pos < r.end) {
            std::uint64_t key = binary_detail::read_varint(r);
            std::uint32_t tag = static_cast<std::uint32_t>(key >> 3);
            std::uint8_t wt = static_cast<std::uint8_t>(key & 7);
            if (tag == 1) o.x = binary_detail::zigzag_decode(binary_detail::read_varint(r));
            else if (tag == 2) o.y = binary_detail::zigzag_decode(binary_detail::read_varint(r));
            else binary_detail::skip_value(r, wt);
        }
        return o;
    }
    static void encode_payload(ByteBuf& out, const T& o, alloc_t a) {
        ByteBuf body(a);
        encode_record(body, o, a);
        binary_detail::write_len_raw(out, std::span<const std::byte>(body.data(), body.size()));
    }
    static T decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t a) {
        binary_detail::Reader inner = binary_detail::read_len_window(r);
        return decode_record(inner, a);
    }
};

// ── Generated server base (emit-service.ts shape): meta() + dispatch() + typed pure virtuals. ──
namespace app::services {
class PointService : public keyma::service {
public:
    virtual ~PointService() = default;
    // ctx injected LAST.
    virtual keyma::task<app::Point> translate(const app::Point& p, std::int64_t dx,
                                              const keyma::RequestContext& ctx) = 0;
    virtual keyma::task<bool> whoami(const keyma::RequestContext& ctx) = 0;
    virtual keyma::task<std::int64_t> secret(const keyma::RequestContext& ctx) = 0;  // private

    const keyma::service_meta& meta() const override {
        static const keyma::service_param_meta translate_params[] = {{"p"}, {"dx"}};
        static const keyma::service_method_meta methods[] = {
            {"translate", keyma::Visibility::Public, std::span<const keyma::service_param_meta>(translate_params)},
            {"whoami", keyma::Visibility::Public, {}},
            {"secret", keyma::Visibility::Private, {}},
        };
        static const keyma::service_meta m{"PointService", keyma::Visibility::Public,
                                           std::span<const keyma::service_method_meta>(methods)};
        return m;
    }

    keyma::task<keyma::call_result> dispatch(std::string_view method, const keyma::wire_payload& payload,
                                             const keyma::RequestContext& ctx, keyma::encoding enc,
                                             keyma::alloc_t a) override {
        try {
            if (method == "translate") {
                // Decode args (positional binary or named-arg JSON) into locals BEFORE any
                // suspension (no dangling reference across a co_await).
                app::Point __p;
                std::int64_t __dx;
                if (enc == keyma::encoding::binary) {
                    const keyma::ByteBuf& __b = std::get<keyma::ByteBuf>(payload);
                    keyma::binary_detail::Reader __r{std::span<const std::byte>(__b.data(), __b.size()), 0, __b.size()};
                    __p = keyma::binary_traits<app::Point>::decode_payload(__r, keyma::binary_traits<app::Point>::wiretype, a);
                    __dx = keyma::binary_traits<std::int64_t>::decode_payload(__r, keyma::binary_traits<std::int64_t>::wiretype, a);
                } else {
                    const keyma::Value& __args = std::get<keyma::Value>(payload);
                    __p = keyma::from_value<app::Point>(__args.at("p"), a);
                    __dx = keyma::from_value<std::int64_t>(__args.at("dx"), a);
                }
                app::Point __res = co_await this->translate(__p, __dx, ctx);
                if (enc == keyma::encoding::binary) {
                    keyma::ByteBuf __out(a);
                    keyma::binary_traits<app::Point>::encode_payload(__out, __res, a);
                    co_return keyma::call_result::success(keyma::wire_payload(std::move(__out)));
                }
                co_return keyma::call_result::success(keyma::wire_payload(keyma::to_value(__res, a)));
            }
            if (method == "whoami") {
                bool __res = co_await this->whoami(ctx);
                if (enc == keyma::encoding::binary) {
                    keyma::ByteBuf __out(a);
                    keyma::binary_traits<bool>::encode_payload(__out, __res, a);
                    co_return keyma::call_result::success(keyma::wire_payload(std::move(__out)));
                }
                co_return keyma::call_result::success(keyma::wire_payload(keyma::to_value(__res, a)));
            }
            if (method == "secret") {
                std::int64_t __res = co_await this->secret(ctx);
                if (enc == keyma::encoding::binary) {
                    keyma::ByteBuf __out(a);
                    keyma::binary_traits<std::int64_t>::encode_payload(__out, __res, a);
                    co_return keyma::call_result::success(keyma::wire_payload(std::move(__out)));
                }
                co_return keyma::call_result::success(keyma::wire_payload(keyma::to_value(__res, a)));
            }
            co_return keyma::call_result::failure(keyma::error_code::method_not_found, "method not found");
        } catch (const std::exception& __e) {
            co_return keyma::call_result::failure(keyma::error_code::handler_error, __e.what());
        }
    }
};
}  // namespace app::services

// ── Generated client (emit-service-client.ts shape): bound to a transport, task<result<T, error>>. ──
namespace app::client {
class PointService {
public:
    explicit PointService(keyma::transport& transport, keyma::alloc_t alloc = {})
        : __tx(&transport), __alloc(alloc) {}

    keyma::task<keyma::result<app::Point, keyma::error>> translate(const app::Point& p, std::int64_t dx) {
        keyma::encoding __enc = __tx->wire_encoding();
        keyma::wire_payload __args;
        if (__enc == keyma::encoding::binary) {
            keyma::ByteBuf __buf(__alloc);
            keyma::binary_traits<app::Point>::encode_payload(__buf, p, __alloc);
            keyma::binary_traits<std::int64_t>::encode_payload(__buf, dx, __alloc);
            __args = keyma::wire_payload(std::move(__buf));
        } else {
            keyma::Value __obj = keyma::Value::object(__alloc);
            __obj.set("p", keyma::to_value(p, __alloc));
            __obj.set("dx", keyma::to_value(dx, __alloc));
            __args = keyma::wire_payload(std::move(__obj));
        }
        keyma::result<keyma::wire_payload, keyma::error> __r =
            co_await keyma::client_invoke(*__tx, "PointService", "translate", std::move(__args));
        if (!__r.has_value()) co_return std::unexpected(__r.error());
        if (__enc == keyma::encoding::binary) {
            const keyma::ByteBuf& __b = std::get<keyma::ByteBuf>(*__r);
            keyma::binary_detail::Reader __rd{std::span<const std::byte>(__b.data(), __b.size()), 0, __b.size()};
            co_return keyma::result<app::Point, keyma::error>(
                keyma::binary_traits<app::Point>::decode_payload(__rd, keyma::binary_traits<app::Point>::wiretype, __alloc));
        }
        co_return keyma::result<app::Point, keyma::error>(keyma::from_value<app::Point>(std::get<keyma::Value>(*__r), __alloc));
    }

    keyma::task<keyma::result<bool, keyma::error>> whoami() {
        keyma::encoding __enc = __tx->wire_encoding();
        keyma::wire_payload __args = keyma::empty_payload(__enc, __alloc);
        keyma::result<keyma::wire_payload, keyma::error> __r =
            co_await keyma::client_invoke(*__tx, "PointService", "whoami", std::move(__args));
        if (!__r.has_value()) co_return std::unexpected(__r.error());
        if (__enc == keyma::encoding::binary) {
            const keyma::ByteBuf& __b = std::get<keyma::ByteBuf>(*__r);
            keyma::binary_detail::Reader __rd{std::span<const std::byte>(__b.data(), __b.size()), 0, __b.size()};
            co_return keyma::result<bool, keyma::error>(
                keyma::binary_traits<bool>::decode_payload(__rd, keyma::binary_traits<bool>::wiretype, __alloc));
        }
        co_return keyma::result<bool, keyma::error>(keyma::from_value<bool>(std::get<keyma::Value>(*__r), __alloc));
    }

    keyma::task<keyma::result<std::int64_t, keyma::error>> secret() {
        keyma::encoding __enc = __tx->wire_encoding();
        keyma::wire_payload __args = keyma::empty_payload(__enc, __alloc);
        keyma::result<keyma::wire_payload, keyma::error> __r =
            co_await keyma::client_invoke(*__tx, "PointService", "secret", std::move(__args));
        if (!__r.has_value()) co_return std::unexpected(__r.error());
        if (__enc == keyma::encoding::binary) {
            const keyma::ByteBuf& __b = std::get<keyma::ByteBuf>(*__r);
            keyma::binary_detail::Reader __rd{std::span<const std::byte>(__b.data(), __b.size()), 0, __b.size()};
            co_return keyma::result<std::int64_t, keyma::error>(
                keyma::binary_traits<std::int64_t>::decode_payload(__rd, keyma::binary_traits<std::int64_t>::wiretype, __alloc));
        }
        co_return keyma::result<std::int64_t, keyma::error>(keyma::from_value<std::int64_t>(std::get<keyma::Value>(*__r), __alloc));
    }

private:
    keyma::transport* __tx;
    keyma::alloc_t __alloc;
};
}  // namespace app::client

// ── The application impl (overrides the pure virtuals). ──
struct PointImpl : app::services::PointService {
    keyma::task<app::Point> translate(const app::Point& p, std::int64_t dx,
                                      const keyma::RequestContext&) override {
        app::Point r;
        r.x = p.x + dx;
        r.y = p.y;
        co_return r;
    }
    keyma::task<bool> whoami(const keyma::RequestContext& ctx) override {
        co_return keyma::ctx_is_system(ctx);
    }
    keyma::task<std::int64_t> secret(const keyma::RequestContext&) override { co_return 1234; }
};

// ── A JSON loopback transport (string wire): serialize the envelope to JSON and back. ──
class json_loopback_transport : public keyma::transport {
public:
    explicit json_loopback_transport(keyma::request_handler& h, keyma::alloc_t a = {})
        : handler_(&h), alloc_(a) {}
    keyma::encoding wire_encoding() const override { return keyma::encoding::json; }
    keyma::task<keyma::call_result> invoke(keyma::call_request req) override {
        std::pmr::string s = keyma::json_stringify(std::get<keyma::Value>(req.args), alloc_);
        keyma::Value args2 = keyma::json_parse(std::string_view(s), alloc_);
        keyma::call_request req2{req.service, req.method, keyma::wire_payload(std::move(args2))};
        keyma::call_result res = co_await handler_->handle(std::move(req2), keyma::RequestContext{}, keyma::encoding::json);
        if (res.ok) {
            std::pmr::string ds = keyma::json_stringify(std::get<keyma::Value>(res.data), alloc_);
            res.data = keyma::wire_payload(keyma::json_parse(std::string_view(ds), alloc_));
        }
        co_return res;
    }
private:
    keyma::request_handler* handler_;
    keyma::alloc_t alloc_;
};

// ── A genuinely-suspending transport bound to an event_loop (its I/O leaf). ──
class suspending_transport : public keyma::transport {
public:
    suspending_transport(keyma::request_handler& h, keyma::event_loop& loop, keyma::alloc_t a = {})
        : handler_(&h), loop_(&loop), alloc_(a) {}
    keyma::encoding wire_encoding() const override { return keyma::encoding::json; }
    keyma::task<keyma::call_result> invoke(keyma::call_request req) override {
        co_await keyma::schedule_on(*loop_);  // suspend at the I/O leaf — resumed by the loop
        keyma::call_result res = co_await handler_->handle(std::move(req), keyma::RequestContext{}, keyma::encoding::json);
        co_return res;
    }
private:
    keyma::request_handler* handler_;
    keyma::event_loop* loop_;
    keyma::alloc_t alloc_;
};

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a{&pool};

    PointImpl impl;
    service_host host(a);
    host.add(impl);

    app::Point p;
    p.x = 1;
    p.y = 2;

    // 1) Direct transport (inline, non-system, JSON). translate works.
    {
        direct_transport tx = create_direct_transport(host, encoding::json, a);
        app::client::PointService client(tx, a);
        result<app::Point, error> r = sync_wait(client.translate(p, 5));
        assert(r.has_value() && r->x == 6 && r->y == 2);
    }

    // 2) Direct transport, BINARY encoding (positional binary arg/result marshalling).
    {
        direct_transport tx = create_direct_transport(host, encoding::binary, a);
        app::client::PointService client(tx, a);
        result<app::Point, error> r = sync_wait(client.translate(p, 40));
        assert(r.has_value() && r->x == 41 && r->y == 2);
    }

    // 3) Gating: a NON-system caller is told the private method does not exist (probe-resistant).
    {
        direct_transport tx = create_direct_transport(host, encoding::json, a);
        app::client::PointService client(tx, a);
        result<std::int64_t, error> r = sync_wait(client.secret());
        assert(!r.has_value());
        assert(std::string_view(r.error().code) == error_code::method_not_found);
    }

    // 4) Gating + ctx: a SYSTEM transport reaches the private method, and ctx.identity.isSystem
    //    is injected through to the impl (whoami returns true).
    {
        direct_transport tx = direct_transport::system(host, encoding::json, a);
        app::client::PointService client(tx, a);
        result<std::int64_t, error> sec = sync_wait(client.secret());
        assert(sec.has_value() && *sec == 1234);
        result<bool, error> who = sync_wait(client.whoami());
        assert(who.has_value() && *who == true);
    }
    // ...and a non-system caller sees whoami() == false (ctx really threads through).
    {
        direct_transport tx = create_direct_transport(host, encoding::json, a);
        app::client::PointService client(tx, a);
        result<bool, error> who = sync_wait(client.whoami());
        assert(who.has_value() && *who == false);
    }
    // Binary gating: a non-system binary caller is also told the private method is not found.
    {
        direct_transport tx = create_direct_transport(host, encoding::binary, a);
        app::client::PointService client(tx, a);
        result<std::int64_t, error> r = sync_wait(client.secret());
        assert(!r.has_value() && std::string_view(r.error().code) == error_code::method_not_found);
    }

    // 5) JSON wire: round-trips the Value envelope through a JSON string.
    {
        json_loopback_transport tx(host, a);
        app::client::PointService client(tx, a);
        result<app::Point, error> r = sync_wait(client.translate(p, 100));
        assert(r.has_value() && r->x == 101 && r->y == 2);
    }

    // 6) A genuinely-suspending transport driven on an event_loop round-trips the call.
    {
        event_loop loop(a);
        suspending_transport tx(host, loop, a);
        app::client::PointService client(tx, a);
        result<app::Point, error> r = sync_wait(client.translate(p, 7), loop);
        assert(r.has_value() && r->x == 8 && r->y == 2);
    }

    // 7) Unknown service / method surface the frozen error codes.
    {
        direct_transport tx = create_direct_transport(host, encoding::json, a);
        call_request bad{std::pmr::string("Nope"), std::pmr::string("x"), wire_payload(Value::object(a))};
        call_result res = sync_wait(tx.invoke(std::move(bad)));
        assert(!res.ok && std::string_view(res.code) == error_code::service_not_found);

        call_request bad2{std::pmr::string("PointService"), std::pmr::string("nope"), wire_payload(Value::object(a))};
        call_result res2 = sync_wait(tx.invoke(std::move(bad2)));
        assert(!res2.ok && std::string_view(res2.code) == error_code::method_not_found);
    }

    return 0;
}
