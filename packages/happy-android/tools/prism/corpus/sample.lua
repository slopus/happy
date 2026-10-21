-- comment
local M = {}
function M.greet(name, times)
  times = times or 1
  for i = 1, times do
    print(string.format("Hello %s #%d", name, i))
  end
  return [[long
string]], 0x10, 3.14
end
return M
