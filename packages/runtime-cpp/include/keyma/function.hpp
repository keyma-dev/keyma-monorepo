#pragma once

// keyma::move_only_function for @keyma/runtime-cpp — a move-only, allocator-aware, type-erasing
// call wrapper standing in for std::move_only_function (so the runtime builds on standard libraries
// that don't ship that type yet — notably Apple clang's libc++ through clang 17). Dependency-free
// (standard library only); composes into the umbrella runtime header without an include cycle.

#include <cstddef>
#include <functional>
#include <memory>
#include <memory_resource>
#include <new>
#include <type_traits>
#include <utility>

namespace keyma {

// ─── move_only_function ───────────────────────────────────────────────────────
//
// A move-only, type-erasing call wrapper for the `R(Args...)` and `R(Args...) const`
// signatures the runtime uses (validators, formatters, transports, lowered query
// clauses). It stands in for std::move_only_function so the runtime builds on standard
// libraries that don't ship that type yet (Apple clang's libc++ through clang 17).
//
// Beyond being a drop-in it is allocator-aware: a small target lives in an inline buffer
// (no allocation); a larger one is allocated from a std::pmr memory resource — the
// caller's, via `move_only_function(std::allocator_arg, alloc, fn)`, or the program
// default resource otherwise — so captured state honours the runtime's pmr discipline.
// Moves are always noexcept (an inline target must be nothrow-movable to qualify; an
// out-of-line target moves by stealing its pointer), so it relocates cleanly inside the
// std::pmr vectors that hold it.

namespace mof_detail {

inline constexpr std::size_t sbo_size = 4 * sizeof(void*);
inline constexpr std::size_t sbo_align = alignof(std::max_align_t);

// A target is stored inline only if it fits the buffer AND moves without throwing, so the
// wrapper's own move stays noexcept; otherwise it is allocated out-of-line.
template <class T>
inline constexpr bool fits_inline =
    sizeof(T) <= sbo_size && alignof(T) <= sbo_align && std::is_nothrow_move_constructible_v<T>;

// Per-target move/destroy, shared by both wrapper specializations (invocation differs by
// const-ness, so it lives in the specialization). The void* is the owning holder.
struct ops {
    void (*move)(void* dst, void* src) noexcept;  // move src's target into the empty dst
    void (*destroy)(void* self) noexcept;
};

// Storage + lifetime, written once and inherited (privately) by the specializations.
class holder {
protected:
    union storage {
        alignas(sbo_align) std::byte buf[sbo_size];
        void* ptr;
        storage() noexcept {}
    } s_;
    const ops* ops_ = nullptr;                 // null ⇒ empty
    std::pmr::memory_resource* mr_ = nullptr;  // resource backing an out-of-line target
    bool inline_ = false;

    holder() noexcept = default;
    holder(holder&&) = delete;  // the specialization drives moves (it also owns invoke_)
    holder& operator=(holder&&) = delete;
    holder(const holder&) = delete;
    holder& operator=(const holder&) = delete;
    ~holder() { reset(); }

    void* target() noexcept { return inline_ ? static_cast<void*>(s_.buf) : s_.ptr; }
    const void* target() const noexcept { return inline_ ? static_cast<const void*>(s_.buf) : s_.ptr; }

    template <class T, class G>
    void emplace(std::pmr::memory_resource* mr, G&& g) {
        if constexpr (fits_inline<T>) {
            ::new (static_cast<void*>(s_.buf)) T(std::forward<G>(g));
            inline_ = true;
            mr_ = nullptr;
        } else {
            void* p = mr->allocate(sizeof(T), alignof(T));
            try {
                ::new (p) T(std::forward<G>(g));
            } catch (...) {
                mr->deallocate(p, sizeof(T), alignof(T));
                throw;
            }
            s_.ptr = p;
            inline_ = false;
            mr_ = mr;
        }
        ops_ = ops_for<T>();  // set last: until here a throw leaves the holder empty
    }

    void reset() noexcept {
        if (ops_) ops_->destroy(this);
        ops_ = nullptr;
        mr_ = nullptr;
        inline_ = false;
    }

    // Move o's target into *this — which MUST be empty — leaving o empty.
    void take(holder& o) noexcept {
        if (o.ops_) o.ops_->move(this, &o);
    }

private:
    template <class T>
    static const ops* ops_for() noexcept {
        static const ops table{
            [](void* dst_, void* src_) noexcept {
                holder& dst = *static_cast<holder*>(dst_);
                holder& src = *static_cast<holder*>(src_);
                if (src.inline_) {
                    T* sf = static_cast<T*>(static_cast<void*>(src.s_.buf));
                    ::new (static_cast<void*>(dst.s_.buf)) T(std::move(*sf));
                    sf->~T();
                    dst.inline_ = true;
                    dst.mr_ = nullptr;
                } else {
                    dst.s_.ptr = src.s_.ptr;  // steal the heap block and its resource
                    dst.inline_ = false;
                    dst.mr_ = src.mr_;
                }
                dst.ops_ = src.ops_;
                src.ops_ = nullptr;
                src.mr_ = nullptr;
                src.inline_ = false;
            },
            [](void* self) noexcept {
                holder& h = *static_cast<holder*>(self);
                T* f = static_cast<T*>(h.target());
                f->~T();
                if (!h.inline_) h.mr_->deallocate(f, sizeof(T), alignof(T));
            }};
        return &table;
    }
};

// SFINAE guard shared by both specializations' target constructors/assignment.
template <class Self, class DT>
inline constexpr bool is_target =
    !std::is_same_v<DT, Self> && !std::is_same_v<DT, std::nullptr_t>;

}  // namespace mof_detail

template <class Sig>
class move_only_function;  // only the two specializations below are defined

// Non-const call signature: the target is invoked as a non-const lvalue.
template <class R, class... Args>
class move_only_function<R(Args...)> : private mof_detail::holder {
public:
    move_only_function() noexcept = default;
    move_only_function(std::nullptr_t) noexcept {}

    template <class F, class DF = std::decay_t<F>,
              std::enable_if_t<mof_detail::is_target<move_only_function, DF> &&
                                   std::is_invocable_r_v<R, DF&, Args...>,
                               int> = 0>
    move_only_function(F&& f) {
        this->template emplace<DF>(std::pmr::get_default_resource(), std::forward<F>(f));
        invoke_ = &invoke_impl<DF>;
    }

    template <class F, class DF = std::decay_t<F>,
              std::enable_if_t<mof_detail::is_target<move_only_function, DF> &&
                                   std::is_invocable_r_v<R, DF&, Args...>,
                               int> = 0>
    move_only_function(std::allocator_arg_t, const std::pmr::polymorphic_allocator<std::byte>& a, F&& f) {
        this->template emplace<DF>(a.resource(), std::forward<F>(f));
        invoke_ = &invoke_impl<DF>;
    }

    move_only_function(move_only_function&& o) noexcept : invoke_(o.invoke_) {
        this->take(o);
        o.invoke_ = nullptr;
    }
    move_only_function& operator=(move_only_function&& o) noexcept {
        if (this != &o) {
            this->reset();
            this->take(o);
            invoke_ = o.invoke_;
            o.invoke_ = nullptr;
        }
        return *this;
    }
    move_only_function& operator=(std::nullptr_t) noexcept {
        this->reset();
        invoke_ = nullptr;
        return *this;
    }
    template <class F, class DF = std::decay_t<F>,
              std::enable_if_t<mof_detail::is_target<move_only_function, DF> &&
                                   std::is_invocable_r_v<R, DF&, Args...>,
                               int> = 0>
    move_only_function& operator=(F&& f) {
        return *this = move_only_function(std::forward<F>(f));
    }

    explicit operator bool() const noexcept { return invoke_ != nullptr; }

    R operator()(Args... args) {
        return invoke_(this->target(), std::forward<Args>(args)...);
    }

private:
    R (*invoke_)(void*, Args&&...) = nullptr;

    template <class T>
    static R invoke_impl(void* t, Args&&... args) {
        return std::invoke(*static_cast<T*>(t), std::forward<Args>(args)...);
    }
};

// Const call signature: the target is invoked as a const lvalue.
template <class R, class... Args>
class move_only_function<R(Args...) const> : private mof_detail::holder {
public:
    move_only_function() noexcept = default;
    move_only_function(std::nullptr_t) noexcept {}

    template <class F, class DF = std::decay_t<F>,
              std::enable_if_t<mof_detail::is_target<move_only_function, DF> &&
                                   std::is_invocable_r_v<R, const DF&, Args...>,
                               int> = 0>
    move_only_function(F&& f) {
        this->template emplace<DF>(std::pmr::get_default_resource(), std::forward<F>(f));
        invoke_ = &invoke_impl<DF>;
    }

    template <class F, class DF = std::decay_t<F>,
              std::enable_if_t<mof_detail::is_target<move_only_function, DF> &&
                                   std::is_invocable_r_v<R, const DF&, Args...>,
                               int> = 0>
    move_only_function(std::allocator_arg_t, const std::pmr::polymorphic_allocator<std::byte>& a, F&& f) {
        this->template emplace<DF>(a.resource(), std::forward<F>(f));
        invoke_ = &invoke_impl<DF>;
    }

    move_only_function(move_only_function&& o) noexcept : invoke_(o.invoke_) {
        this->take(o);
        o.invoke_ = nullptr;
    }
    move_only_function& operator=(move_only_function&& o) noexcept {
        if (this != &o) {
            this->reset();
            this->take(o);
            invoke_ = o.invoke_;
            o.invoke_ = nullptr;
        }
        return *this;
    }
    move_only_function& operator=(std::nullptr_t) noexcept {
        this->reset();
        invoke_ = nullptr;
        return *this;
    }
    template <class F, class DF = std::decay_t<F>,
              std::enable_if_t<mof_detail::is_target<move_only_function, DF> &&
                                   std::is_invocable_r_v<R, const DF&, Args...>,
                               int> = 0>
    move_only_function& operator=(F&& f) {
        return *this = move_only_function(std::forward<F>(f));
    }

    explicit operator bool() const noexcept { return invoke_ != nullptr; }

    R operator()(Args... args) const {
        return invoke_(this->target(), std::forward<Args>(args)...);
    }

private:
    R (*invoke_)(const void*, Args&&...) = nullptr;

    template <class T>
    static R invoke_impl(const void* t, Args&&... args) {
        return std::invoke(*static_cast<const T*>(t), std::forward<Args>(args)...);
    }
};

}  // namespace keyma
