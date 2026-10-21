import strutils
# comment
type Person = object
  name: string
  age: int
proc greet(p: Person): string =
  result = "Hello, " & p.name & " " & $(p.age * 2)
echo greet(Person(name: "nim", age: 3))
let raw = r"C:\path"
