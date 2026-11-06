package demo

class FancyGreeter : BaseGreeter() {
    override fun greet(who: Any, times: Int): String {
        return "fancy"
    }
}
