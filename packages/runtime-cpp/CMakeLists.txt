# @keyma/runtime-cpp — C++23 header-only runtime.
#
# Integrate into a toolchain in any of the usual ways; all expose the same target
# `keyma::runtime` (an INTERFACE library that puts include/ on the path and requests
# C++23):
#
#   add_subdirectory(path/to/runtime-cpp)
#   target_link_libraries(my_app PRIVATE keyma::runtime)
#
#   # FetchContent
#   include(FetchContent)
#   FetchContent_Declare(keyma-runtime-cpp GIT_REPOSITORY ... GIT_TAG ...)
#   FetchContent_MakeAvailable(keyma-runtime-cpp)
#
#   # Installed / packaged
#   find_package(keyma-runtime-cpp CONFIG REQUIRED)
#
# Requires a C++23 standard library with std::expected, std::pmr, std::format and the chrono
# calendar (libstdc++ 14+ or Apple clang 17's libc++). The runtime ships its own
# move_only_function, so std::move_only_function support is NOT required.

cmake_minimum_required(VERSION 3.21)

project(keyma-runtime-cpp
    VERSION 0.1.0
    DESCRIPTION "C++23 header-only runtime consumed by Keyma-generated C++"
    HOMEPAGE_URL "https://github.com/keyma-dev/keyma-monorepo/tree/main/packages/runtime-cpp"
    LANGUAGES CXX)

# Defines CMAKE_INSTALL_INCLUDEDIR/LIBDIR — included up here so the INSTALL_INTERFACE
# include path below resolves to a real value (not an empty string).
include(GNUInstallDirs)

# ── The header-only interface library ──
# The library/package/find_package name stays `keyma-runtime-cpp` (matching the npm package
# @keyma/runtime-cpp); the consumer-facing target is `keyma::runtime`.
add_library(keyma-runtime-cpp INTERFACE)
add_library(keyma::runtime ALIAS keyma-runtime-cpp)

target_include_directories(keyma-runtime-cpp INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)

# Consumers that link this target are compiled as C++23.
target_compile_features(keyma-runtime-cpp INTERFACE cxx_std_23)

# So the installed/exported target is `keyma::runtime` (namespace + EXPORT_NAME), matching
# the build-tree ALIAS above — consumers use one name on every integration path.
set_target_properties(keyma-runtime-cpp PROPERTIES EXPORT_NAME runtime)

# Default the install/test scaffolding to ON only when this is the top-level project, so
# add_subdirectory / FetchContent consumers don't inherit our tests or install rules.
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    set(_keyma_runtime_cpp_top_level ON)
else()
    set(_keyma_runtime_cpp_top_level OFF)
endif()

option(KEYMA_RUNTIME_CPP_INSTALL "Generate install/export rules for keyma::runtime"
       ${_keyma_runtime_cpp_top_level})
option(KEYMA_RUNTIME_CPP_BUILD_TESTS "Build the keyma::runtime tests"
       ${_keyma_runtime_cpp_top_level})

# ── Tests (ctest) ──
# Mirrors scripts/cpp-test.sh: the generated-code-shape TU plus the behavioral server/client/
# json tests and the std::future policy instantiation. Each is a runnable TU.
if(KEYMA_RUNTIME_CPP_BUILD_TESTS)
    enable_testing()
    foreach(_t tu server.test futures.test coroutine.test typed.test)
        string(REPLACE "." "-" _name "${_t}")
        add_executable(keyma-runtime-cpp-${_name} test/${_t}.cpp)
        target_link_libraries(keyma-runtime-cpp-${_name} PRIVATE keyma::runtime)
        add_test(NAME ${_name} COMMAND keyma-runtime-cpp-${_name})
    endforeach()
endif()

# ── Install / package-config so `find_package(keyma-runtime-cpp)` works ──
if(KEYMA_RUNTIME_CPP_INSTALL)
    include(CMakePackageConfigHelpers)

    set(_keyma_runtime_cpp_cmakedir "${CMAKE_INSTALL_LIBDIR}/cmake/keyma-runtime-cpp")

    install(TARGETS keyma-runtime-cpp EXPORT keyma-runtime-cpp-targets)
    install(DIRECTORY include/ DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}")
    install(EXPORT keyma-runtime-cpp-targets
        NAMESPACE keyma::
        FILE keyma-runtime-cpp-targets.cmake
        DESTINATION "${_keyma_runtime_cpp_cmakedir}")

    # Header-only: the config just pulls in the exported target.
    set(_keyma_runtime_cpp_config "${CMAKE_CURRENT_BINARY_DIR}/keyma-runtime-cpp-config.cmake")
    file(WRITE "${_keyma_runtime_cpp_config}"
        "include(\"\${CMAKE_CURRENT_LIST_DIR}/keyma-runtime-cpp-targets.cmake\")\n")
    write_basic_package_version_file(
        "${CMAKE_CURRENT_BINARY_DIR}/keyma-runtime-cpp-config-version.cmake"
        VERSION "${PROJECT_VERSION}"
        COMPATIBILITY SameMajorVersion
        ARCH_INDEPENDENT)
    install(FILES
        "${_keyma_runtime_cpp_config}"
        "${CMAKE_CURRENT_BINARY_DIR}/keyma-runtime-cpp-config-version.cmake"
        DESTINATION "${_keyma_runtime_cpp_cmakedir}")
endif()
