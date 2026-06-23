#pragma once

// Typed query DSL for @keyma/runtime-cpp — the C++ port of the typing layer in
// runtime-js `query.ts` (QueryOp / WhereArg / Projection). It is a COMPILE-TIME facade:
// a typed Where<T> / projection is checked against T's fields (via the per-schema field
// descriptors the C++ backend emits as `struct f`) and then lowered to the exact same
// Mongo-style filter / projection-spec keyma::Value the raw API produces. The wire,
// adapter, server and validator layers stay on keyma::Value — that erasure is correct
// and mirrors TS `Record<string, unknown>`.
//
// This header is consumed only by hand-written client code (and included by client.hpp
// to add Where<T> overloads on the Keyma builders), never by generated model code, so it
// is NOT part of the runtime-header baking/vendoring pipeline. The only generated-code
// dependency is keyma::FieldKind (in runtime.hpp).

#include <keyma/concepts.hpp>
#include <keyma/runtime.hpp>

#include <concepts>
#include <functional>
#include <memory>
#include <optional>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <utility>

namespace keyma {

// ── Field descriptors ──────────────────────────────────────────────────────────
// A descriptor is an empty tag the backend emits per field (as User::f::age): it
// carries the JSON key, the field's LOGICAL value type (Value), the reference target
// (RefTarget, void for non-references), and a FieldKind. Callers pass descriptor
// instances to the operator helpers: eq(User::f::age, 30).

template <class D>
concept FieldDescriptor = requires {
    typename D::Owner;
    typename D::Value;
    typename D::RefTarget;
    { D::key() } -> std::convertible_to<std::string_view>;
    { D::kind } -> std::convertible_to<FieldKind>;
};

template <class D, class Owner>
concept FieldOf = FieldDescriptor<D> && std::same_as<typename D::Owner, Owner>;

// ── Reference / input operand wrappers ───────────────────────────────────────────

// {id} object form for a reference operand (mirrors the TS `{ id }` escape hatch).
template <class Id> struct Ref { Id id; };
template <class Id> Ref(Id) -> Ref<Id>;
template <class> struct is_ref_wrapper : std::false_type {};
template <class Id> struct is_ref_wrapper<Ref<Id>> : std::true_type {};

// Distinguishes an in/nin predicate (operand is a std::tuple of values) from a single-
// operand predicate, so Where::add can branch at compile time.
template <class> struct is_operand_pack : std::false_type {};
template <class... Ts> struct is_operand_pack<std::tuple<Ts...>> : std::true_type {};

// A typed, late-bound input placeholder. V is the value type the placeholder must be
// bound to (compile-time check only); it lowers to the {"$keyma_input": name} sentinel
// resolved by Document at request time — identical to Keyma::input(name).
template <class V = Value> struct Input {
    std::string_view name;
    using value_type = V;
};
template <class> struct is_input : std::false_type {};
template <class V> struct is_input<Input<V>> : std::true_type {};
template <class A> concept IsInput = is_input<std::decay_t<A>>::value;
template <class V = Value> constexpr Input<V> input(std::string_view name) { return Input<V>{name}; }

// ── Operand-compatibility concepts ───────────────────────────────────────────────

// An argument comparable to the field's logical value (convertible to it; an enum must
// match exactly; a json field accepts anything serializable).
template <class A, class D>
concept ComparableTo = FieldDescriptor<D> &&
    (std::convertible_to<std::decay_t<A>, typename D::Value>
     || (D::kind == FieldKind::Enum && std::same_as<std::decay_t<A>, typename D::Value>)
     || D::kind == FieldKind::Json);

// Relational operators ($gt/$gte/$lt/$lte) require an orderable field (not Scalar/Json).
template <class D>
concept OrderedField = FieldDescriptor<D> &&
    (D::kind == FieldKind::Ordered || D::kind == FieldKind::Reference || D::kind == FieldKind::Enum);

// A reference-field operand: a bare id, an {id} wrapper, a target instance, or a shared
// handle to one. (Downstream normalize_reference_ids collapses all of these to a bare id.)
template <class A, class D>
concept RefArg = FieldDescriptor<D> && (D::kind == FieldKind::Reference) &&
    (std::convertible_to<std::decay_t<A>, typename D::Value>
     || is_ref_wrapper<std::decay_t<A>>::value
     || std::same_as<std::decay_t<A>, typename D::RefTarget>
     || std::same_as<std::decay_t<A>, std::shared_ptr<typename D::RefTarget>>);

// ── Operand lowering ─────────────────────────────────────────────────────────────

template <class D, class A>
inline Value lower_ref_operand(const A& arg, alloc_t a) {
    using AA = std::decay_t<A>;
    if constexpr (is_ref_wrapper<AA>::value) {
        Value o = Value::object(a);
        o.set("id", keyma::to_value(arg.id, a));
        return o;
    } else if constexpr (std::is_same_v<AA, typename D::RefTarget>) {
        return value_traits<typename D::RefTarget>::id_value(arg, a);
    } else if constexpr (std::is_same_v<AA, std::shared_ptr<typename D::RefTarget>>) {
        return arg ? value_traits<typename D::RefTarget>::id_value(*arg, a) : Value(nullptr, a);
    } else {
        return keyma::to_value(arg, a);  // bare id
    }
}

// Lower a single operand to a Value, dispatching on the descriptor's kind / operand type.
template <class D, class A>
inline Value lower_operand(const A& v, alloc_t a) {
    using AA = std::decay_t<A>;
    if constexpr (is_input<AA>::value) {
        Value o = Value::object(a);
        o.set("$keyma_input", Value(v.name, a));
        return o;
    } else if constexpr (D::kind == FieldKind::Reference) {
        return lower_ref_operand<D>(v, a);
    } else if constexpr (D::kind == FieldKind::Enum) {
        return Value(keyma::to_string(v), a);  // enum -> wire string
    } else {
        return keyma::to_value(v, a);
    }
}

// ── Predicates ───────────────────────────────────────────────────────────────────

enum class CmpOp { Eq, Ne, Gt, Gte, Lt, Lte, In, Nin };

inline const char* cmp_key(CmpOp op) {
    switch (op) {
        case CmpOp::Eq: return "$eq";
        case CmpOp::Ne: return "$ne";
        case CmpOp::Gt: return "$gt";
        case CmpOp::Gte: return "$gte";
        case CmpOp::Lt: return "$lt";
        case CmpOp::Lte: return "$lte";
        case CmpOp::In: return "$in";
        case CmpOp::Nin: return "$nin";
    }
    return "$eq";
}

// A typed field predicate: the descriptor, the operator, and the operand stored BY VALUE
// (a single value, or a std::tuple for in/nin). Lowered to Value lazily at Where::to_value
// time so the request allocator — not a construction-time one — owns every node.
template <FieldDescriptor D, class Operand>
struct FieldPredicate {
    using descriptor = D;
    CmpOp op;
    Operand operand;
    bool bare = false;  // true => { key: value } rather than { key: { $op: value } }
};

// Bare equality: { field: value } (the common literal form; what the raw API produces).
template <FieldDescriptor D, class A>
    requires (ComparableTo<A, D> || RefArg<A, D> || IsInput<A>)
auto field(D, A&& a) {
    return FieldPredicate<D, std::decay_t<A>>{CmpOp::Eq, std::forward<A>(a), true};
}

#define KEYMA_CMP(NAME, OP)                                                          \
    template <FieldDescriptor D, class A>                                            \
        requires (ComparableTo<A, D> || RefArg<A, D> || IsInput<A>)                  \
    auto NAME(D, A&& a) {                                                            \
        return FieldPredicate<D, std::decay_t<A>>{CmpOp::OP, std::forward<A>(a)}; \
    }
KEYMA_CMP(eq, Eq)
KEYMA_CMP(ne, Ne)
#undef KEYMA_CMP

#define KEYMA_ORD(NAME, OP)                                                          \
    template <OrderedField D, class A>                                               \
        requires (ComparableTo<A, D> || IsInput<A>)                                 \
    auto NAME(D, A&& a) {                                                            \
        return FieldPredicate<D, std::decay_t<A>>{CmpOp::OP, std::forward<A>(a)}; \
    }
KEYMA_ORD(gt, Gt)
KEYMA_ORD(gte, Gte)
KEYMA_ORD(lt, Lt)
KEYMA_ORD(lte, Lte)
#undef KEYMA_ORD

template <FieldDescriptor D, class... As>
    requires (sizeof...(As) > 0 && (... && (ComparableTo<As, D> || RefArg<As, D> || IsInput<As>)))
auto in(D, As&&... as) {
    return FieldPredicate<D, std::tuple<std::decay_t<As>...>>{
        CmpOp::In, std::tuple<std::decay_t<As>...>(std::forward<As>(as)...)};
}
template <FieldDescriptor D, class... As>
    requires (sizeof...(As) > 0 && (... && (ComparableTo<As, D> || RefArg<As, D> || IsInput<As>)))
auto nin(D, As&&... as) {
    return FieldPredicate<D, std::tuple<std::decay_t<As>...>>{
        CmpOp::Nin, std::tuple<std::decay_t<As>...>(std::forward<As>(as)...)};
}

// ── Where<T> ─────────────────────────────────────────────────────────────────────

template <class T>
class Where {
public:
    using Owner = T;
    using allocator_type = alloc_t;

    explicit Where(alloc_t a = {}) : a_(a), clauses_(a), groups_(a) {}

    // Add a typed field predicate (only for THIS owner's fields).
    template <FieldDescriptor D, class Op>
        requires std::same_as<typename D::Owner, T>
    Where& add(FieldPredicate<D, Op> p) {
        if constexpr (is_operand_pack<Op>::value) {  // in / nin: operand is a tuple of values
            clauses_.push_back(Clause{
                std::pmr::string(D::key(), a_), false, std::pmr::string(cmp_key(p.op), a_),
                move_only_function<Value(alloc_t) const>(std::allocator_arg, a_,
                    [p = std::move(p)](alloc_t a) -> Value {
                        Value arr = Value::array(a);
                        std::apply([&](const auto&... xs) { (arr.push(lower_operand<D>(xs, a)), ...); }, p.operand);
                        return arr;
                    })});
        } else {  // single operand: bare { key: v } or operator { key: { $op: v } }
            const bool bare = p.bare;
            std::pmr::string opkey = bare ? std::pmr::string(a_) : std::pmr::string(cmp_key(p.op), a_);
            clauses_.push_back(Clause{
                std::pmr::string(D::key(), a_), bare, std::move(opkey),
                move_only_function<Value(alloc_t) const>(std::allocator_arg, a_,
                    [p = std::move(p)](alloc_t a) -> Value { return lower_operand<D>(p.operand, a); })});
        }
        return *this;
    }

    // Merge another Where<T>'s clauses/groups into this one (used by the where() factory
    // and the logical combinators).
    Where& merge(Where&& other) {
        for (auto& c : other.clauses_) clauses_.push_back(std::move(c));
        for (auto& g : other.groups_) groups_.push_back(std::move(g));
        return *this;
    }

    // Append a logical group ($and/$or/$nor) over sub-Wheres of the same owner.
    template <class... Ws>
    void add_group(const char* opkey, Ws&&... ws) {
        groups_.push_back(Group{
            std::pmr::string(opkey, a_),
            move_only_function<Value(alloc_t) const>(std::allocator_arg, a_,
                [tup = std::make_tuple(std::forward<Ws>(ws)...)](alloc_t a) -> Value {
                    Value arr = Value::array(a);
                    std::apply([&](const auto&... w) { (arr.push(w.to_value(a)), ...); }, tup);
                    return arr;
                })});
    }

    // Lower to the Mongo-style filter Value (allocator-threaded). Field clauses AND
    // implicitly; multiple operator clauses on one key merge into one operator object.
    Value to_value(alloc_t a) const {
        Value obj = Value::object(a);
        for (const Clause& c : clauses_) {
            if (c.bare) {
                obj.set(std::string_view(c.key), c.lower(a));
            } else {
                Value op_obj = (obj.find(std::string_view(c.key)) != nullptr)
                                   ? Value(obj.at(std::string_view(c.key)), a)
                                   : Value::object(a);
                op_obj.set(std::string_view(c.opkey), c.lower(a));
                obj.set(std::string_view(c.key), std::move(op_obj));
            }
        }
        for (const Group& g : groups_) obj.set(std::string_view(g.key), g.lower(a));
        return obj;
    }

private:
    struct Clause {
        std::pmr::string key;
        bool bare;
        std::pmr::string opkey;
        move_only_function<Value(alloc_t) const> lower;
    };
    struct Group {
        std::pmr::string key;
        move_only_function<Value(alloc_t) const> lower;
    };
    alloc_t a_;
    std::pmr::vector<Clause> clauses_;
    std::pmr::vector<Group> groups_;
};

// Factory: where<User>(a, gte(User::f::age, 18), eq(User::f::status, Status::Active), ...).
// Accepts field predicates and/or sub-Where<T> groups (from and_/or_/nor_).
template <class T, class... Ps>
Where<T> where(alloc_t a, Ps&&... ps) {
    Where<T> w(a);
    auto one = [&](auto&& p) {
        using P = std::remove_cvref_t<decltype(p)>;
        if constexpr (std::is_same_v<P, Where<T>>) w.merge(std::move(p));
        else w.add(std::forward<decltype(p)>(p));
    };
    (one(std::forward<Ps>(ps)), ...);
    return w;
}

// Logical combinators over sub-Wheres of the same owner.
template <class T, class... Ws>
    requires (... && std::same_as<typename std::remove_cvref_t<Ws>::Owner, T>)
Where<T> and_(alloc_t a, Ws&&... ws) { Where<T> w(a); w.add_group("$and", std::forward<Ws>(ws)...); return w; }
template <class T, class... Ws>
    requires (... && std::same_as<typename std::remove_cvref_t<Ws>::Owner, T>)
Where<T> or_(alloc_t a, Ws&&... ws) { Where<T> w(a); w.add_group("$or", std::forward<Ws>(ws)...); return w; }
template <class T, class... Ws>
    requires (... && std::same_as<typename std::remove_cvref_t<Ws>::Owner, T>)
Where<T> nor_(alloc_t a, Ws&&... ws) { Where<T> w(a); w.add_group("$nor", std::forward<Ws>(ws)...); return w; }

// ── Projections ──────────────────────────────────────────────────────────────────

// Build a projection-spec Value from typed field descriptors (compile-time field-name +
// ownership checked). Lowers to { field: 1, ... } — the shape the server's
// build_adapter_projection consumes. Result-type narrowing is NOT applied: the hydrated
// type stays T (the wire payload narrows, the static type does not). See Projected below.
template <class T, FieldDescriptor D0, FieldDescriptor... Ds>
    requires (std::same_as<typename D0::Owner, T> && (... && std::same_as<typename Ds::Owner, T>))
Value project(alloc_t a, D0, Ds...) {
    Value o = Value::object(a);
    o.set(std::string_view(D0::key()), Value(std::int64_t{1}, a));
    (o.set(std::string_view(Ds::key()), Value(std::int64_t{1}, a)), ...);
    return o;
}

// The static result type of a projection. C++23 cannot synthesize a narrowed struct from
// a value-level projection (no member reflection until C++26 / P2996), so the shipping
// default is PASSTHROUGH (= T). When a reflection-capable toolchain is in use, a future
// gated specialization here can synthesize a struct containing only Ds... (using
// std::meta::define_aggregate over the selected descriptors) without changing call sites.
// Evaluated on the project's current toolchains (GCC 14 / Apple Clang 17): __cpp_reflection
// is undefined, so the gate stays off and Projected resolves to T.
template <class T, FieldDescriptor... Ds>
using Projected = T;

}  // namespace keyma
