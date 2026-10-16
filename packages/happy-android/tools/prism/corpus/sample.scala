package demo
import scala.util.Try
/** Doc */
case class Person(name: String, age: Int = 30)
object Main extends App {
  val people = List(Person("a"), Person("b", 40))
  def greet(p: Person): String = s"Hello ${p.name}, ${p.age * 2}"
  people.filter(_.age > 18).foreach(p => println(greet(p))) // done
  val x = 'symbol
}
