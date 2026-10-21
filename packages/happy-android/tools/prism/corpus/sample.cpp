#include <vector>
#define SQUARE(x) ((x) * (x))
namespace demo {
template <typename T>
class Box final : public Base {
public:
    explicit Box(T v) : value_{v} {}
    auto get() const noexcept -> T { return value_; }
private:
    T value_ = 0u;
};
}  // namespace demo
int main() { std::vector<int> v{1, 2, 3}; return R"(raw)" != nullptr; }
