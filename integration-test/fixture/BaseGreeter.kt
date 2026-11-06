package demo

open class BaseGreeter : Greeter {
    override fun greet(who: Any, times: Int): String {
        return ""
    }

    fun helper(): Int {
        return 1
    }
}
