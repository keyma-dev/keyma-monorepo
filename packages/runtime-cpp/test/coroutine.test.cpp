// Exercises the concrete async core (keyma/async.hpp): keyma::task<T> (value / void / exception
// capture, symmetric transfer), keyma::event_loop (schedule / schedule_op / schedule_after /
// process / flush), the scheduler concepts, and sync_wait on both the inline and the
// event_loop-driven path. Built (and additionally run under -fsanitize=address by
// scripts/cpp-test.sh) to catch any dangling reference across a suspension point.

#include <keyma/runtime.hpp>

#include <cassert>
#include <chrono>
#include <memory_resource>
#include <string>
#include <vector>

using namespace keyma;

// ── A leaf coroutine that genuinely suspends on the loop before producing its value. ──
static task<int> deferred_add(event_loop& loop, int a, int b) {
    co_await schedule_on(loop);  // suspend; the loop resumes us later
    co_return a + b;
}

// A driver that chains several genuinely-suspending awaits — every intermediate has a named
// lifetime spanning its suspension (the discipline that keeps ASan clean).
static task<int> chain(event_loop& loop) {
    task<int> t1 = deferred_add(loop, 1, 2);
    int x = co_await std::move(t1);
    task<int> t2 = deferred_add(loop, x, 10);
    int y = co_await std::move(t2);
    co_return y;  // (1+2)+10 = 13
}

static task<int> throws() {
    co_await std::suspend_never{};
    throw std::runtime_error("boom");
    co_return 0;
}

static task<void> set_flag(bool* flag) {
    *flag = true;
    co_return;
}

int main() {
    std::pmr::monotonic_buffer_resource pool;
    std::pmr::polymorphic_allocator<std::byte> a{&pool};

    // 1) Inline task<T>: completes on first resume (no scheduler) — the direct-transport path.
    {
        auto t = []() -> task<int> { co_return 42; }();
        assert(sync_wait(std::move(t)) == 42);
    }

    // 2) Inline task<void>.
    {
        bool flag = false;
        sync_wait(set_flag(&flag));
        assert(flag);
    }

    // 3) Exception capture: the throw is captured into the task and re-raised at extraction.
    {
        bool caught = false;
        try {
            (void)sync_wait(throws());
        } catch (const std::runtime_error& e) {
            caught = std::string(e.what()) == "boom";
        }
        assert(caught);
    }

    // 4) Genuinely-suspending chain driven on the event_loop.
    {
        event_loop loop{a};
        int r = sync_wait(chain(loop), loop);
        assert(r == 13);
    }

    // 5) event_loop bounded tick (process) vs full drain (flush), plus has_immediate_work.
    {
        event_loop loop{a};
        int hits = 0;
        // Three independent suspending tasks; start them all, then drain in bounded ticks.
        auto mk = [&]() -> task<void> { co_await schedule_on(loop); ++hits; co_return; };
        task<void> a1 = mk(), a2 = mk(), a3 = mk();
        a1.start(); a2.start(); a3.start();
        assert(loop.has_immediate_work());
        std::size_t ran = loop.process(2);  // bounded: at most 2 ready handles
        assert(ran == 2 && hits == 2);
        loop.flush();
        assert(hits == 3 && !loop.has_immediate_work());
    }

    // 6) DelayedScheduler: schedule_after fires in due order on flush (logical clock — no sleep).
    {
        event_loop loop{a};
        std::pmr::vector<int> order(a);
        auto at = [&](int tag, int ms) -> task<void> {
            // a leaf that reschedules itself after `ms`
            struct delay_awaiter {
                event_loop* loop; std::chrono::milliseconds d;
                bool await_ready() const noexcept { return false; }
                void await_suspend(std::coroutine_handle<> h) const { loop->schedule_after(h, d); }
                void await_resume() const noexcept {}
            };
            co_await delay_awaiter{&loop, std::chrono::milliseconds{ms}};
            order.push_back(tag);
            co_return;
        };
        task<void> d1 = at(1, 30), d2 = at(2, 10), d3 = at(3, 20);
        d1.start(); d2.start(); d3.start();
        loop.flush();
        assert((order.size() == 3 && order[0] == 2 && order[1] == 3 && order[2] == 1));
    }

    return 0;
}
