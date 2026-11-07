package com.slopus.happy.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The vectors are link.happy.page's own (`link.happy.page/src/link.test.ts`
 * in slopus/happy-link), as desktop's `happyShareLink.test.ts` takes them, so
 * the phone writes and reads exactly what the page does.
 */
class HappyShareLinksTest {
    private val instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
    private val other = "m1n2b3v4c5x6z7l8k9j0h1g2"
    private val id = "t7bgxjt05aexj73frl6ul37e"
    private val page = "https://link.happy.page/#"

    @Test
    fun roundTrip() {
        val cases = listOf(
            Triple("happy://$instance/agents/$id", "1/$instance/agents/$id", null),
            Triple("happy://$instance/agents/$id", "1/$instance/agents/$id?as=task", HappyShareRole.Task),
            Triple("happy://$instance/agents/$id", "1/$instance/agents/$id?as=bot", HappyShareRole.Bot),
            Triple("happy://$instance/agents/$id", "1/$instance/agents/$id?as=subtask", HappyShareRole.Subtask),
            Triple("happy://$instance/agents/$id", "1/$instance/agents/$id?as=subagent", HappyShareRole.Subagent),
            Triple("happy://$instance/agents/$id", "1/$instance/agents/$id?as=session", HappyShareRole.Session),
            Triple("happy://$instance/artifacts/$id", "1/$instance/artifacts/$id", null),
            Triple("happy://$instance/artifacts/$id?version=12", "1/$instance/artifacts/$id?version=12", null),
            Triple("happy://$instance/workspaces/$id", "1/$instance/workspaces/$id", null),
            Triple("happy://$instance/projects/$id", "1/$instance/projects/$id", null),
            Triple("happy://$instance/surfaces/$id", "1/$instance/surfaces/$id", null),
            Triple("happy://$instance/users/$id", "1/$instance/users/$id", null),
            Triple("happy://$instance/workspaces/ws_1/services/web-2", "1/$instance/workspaces/ws_1/services/web-2", null),
            Triple("happy://$instance/agents/$id/files/src/main.ts#L42", "1/$instance/agents/$id/files/src/main.ts?lines=42", null),
            Triple("happy://$instance/workspaces/$id/files/docs/My%20Notes.md#L3-L9", "1/$instance/workspaces/$id/files/docs/My%20Notes.md?lines=3-9", null),
        )
        for ((url, payload, role) in cases) {
            assertEquals(payload, "$page$payload", HappyShareLinks.format(url, role))
            assertEquals(payload, HappyShareTarget(url, instance, role), HappyShareLinks.parse("$page$payload"))
        }
    }

    @Test
    fun refusesWhateverIsNotExactlyAShareLink() {
        val fragments = listOf(
            "",
            "2/$instance/agents/$id",
            "10/$instance/agents/$id",
            "1/$instance/agents/${"a".repeat(4100)}",
            // link.happy.engineering's v1: names something, but no installation.
            "1/agents/$id",
            "1/artifacts/$id?version=2",
            "hello",
            "1/",
            "1/$instance",
            "1/$instance/",
            "1/${instance.uppercase()}/agents/$id",
            "1/${instance}x/agents/$id",
            "1/9${instance.drop(1)}/agents/$id",
            "1/$instance/agent/$id",
            "1/$instance/agents/$id/",
            "1/$instance/agents/a.b",
            "1/$instance/sessions/$id",
            "1/$instance/agents/$id?title=Plan",
            "1/$instance/chief-of-staff?text=hi",
            "1/$instance/organizations/org_1/join",
            "1/$instance/agents/$id?as=task&as=bot",
            "1/$instance/agents/$id?as=Task",
            "1/$instance/agents/$id?as=admin",
            "1/$instance/agents/$id?as=",
            "1/$instance/agents/$id?",
            "1/$instance/artifacts/$id?as=task",
            "1/$instance/agents/$id?version=2",
            "1/$instance/artifacts/$id?version=0",
            "1/$instance/artifacts/$id?version=01",
            "1/$instance/artifacts/$id?version=1000000000",
            "1/$instance/agents/$id/files/a/../b",
            "1/$instance/agents/$id/files/a%2Fb",
            "1/$instance/agents/$id/files/a%5Cb",
            "1/$instance/agents/$id/files/a%00b",
            "1/$instance/agents/$id/files/a%zz",
            "1/$instance/agents/$id/files/a//b",
            "1/$instance/agents/$id/files/a.ts?lines=9-3",
            "1/$instance/agents/$id/files/a.ts?lines=L9",
            "1/$instance/agents/$id#x",
            "1/$instance/agents/$id?as=task#x",
            "1/javascript:alert(1)",
            // A stray `%` at the end, and bytes that aren't UTF-8.
            "1/$instance/agents/$id/files/a%",
            "1/$instance/agents/$id/files/a%2",
            "1/$instance/agents/$id/files/a%C3",
            // Java's `$` would take one before a final line break; JavaScript's doesn't.
            "1/$instance/agents/$id\n",
        )
        for (fragment in fragments) assertNull(fragment.take(80), HappyShareLinks.parse("$page$fragment"))
        for (url in listOf(
            "https://link.happy.engineering/#1/$instance/agents/$id",
            "http://link.happy.page/#1/$instance/agents/$id",
            "https://link.happy.page.evil.com/#1/$instance/agents/$id",
            "https://evil.com/?https://link.happy.page/#1/$instance/agents/$id",
        )) assertNull(url, HappyShareLinks.parse(url))
    }

    @Test
    fun writesAShareLinkOnlyForACanonicalInstanceLink() {
        for (url in listOf(
            "happy://agents/$id",
            "happy://$instance/agents/$id/",
            "happy://$instance/agents/$id?as=task",
            "happy://$instance/agents/$id/files/a%2fb",
            "${page}1/$instance/agents/$id",
            "HAPPY://$instance/agents/$id",
            "happy://$instance/settings/general",
            "happy://$instance/agents/$id\n",
        )) assertNull(url, HappyShareLinks.format(url))
        // The role is said of agents only.
        assertNull(HappyShareLinks.format("happy://$instance/artifacts/$id", HappyShareRole.Task))
    }

    @Test
    fun formatsALinkForAnInstance() {
        assertEquals(
            "${page}1/$instance/agents/$id?as=bot",
            HappyShareLinks.format(HappyLink.Reference(HappyReferenceKind.Agent, id), instance, HappyShareRole.Bot),
        )
        assertEquals(
            "${page}1/$instance/artifacts/$id?version=3",
            HappyShareLinks.format(HappyLink.Reference(HappyReferenceKind.Artifact, id, version = 3), instance),
        )
        // No instance, no link that leaves the app.
        assertNull(HappyShareLinks.format(HappyLink.Reference(HappyReferenceKind.Agent, id), null))
        assertNull(HappyShareLinks.format(HappyLink.Settings("general"), instance))
    }

    @Test
    fun opensAsTheInstanceLinkItCarries() {
        val target = HappyShareLinks.parse("${page}1/$instance/artifacts/$id?version=2")!!
        val opened = HappyUrls.parse(target.url)!!
        assertEquals(instance, opened.instanceId)
        assertEquals(HappyLink.Reference(HappyReferenceKind.Artifact, id, version = 2), opened.link)
        // A percent-encoded parameter is read as the page reads it.
        assertEquals(HappyShareRole.Task, HappyShareLinks.parse("${page}1/$instance/agents/$id?as=%74ask")?.role)
    }

    @Test
    fun readsShareLinksNamingThisInstanceInMarkdownAsTheHappyLinksTheyCarry() {
        val share = "${page}1/$instance/agents/$id?as=task"
        val happy = "happy://$instance/agents/$id"
        val foreign = "${page}1/$other/agents/$id"
        val here = { instanceId: String -> instanceId == instance }
        assertEquals("See [](${happy}).", HappyShareLinks.rewrite("See $share.", here))
        assertEquals("See [the plan]($happy) now", HappyShareLinks.rewrite("See [the plan]($share) now", here))
        assertEquals("[]($happy)", HappyShareLinks.rewrite("<$share>", here))
        // Another server's, or any without an instance here, is a web address.
        assertEquals("See $foreign", HappyShareLinks.rewrite("See $foreign", here))
        assertEquals("See $share", HappyShareLinks.rewrite("See $share", { false }))
        // Code stays literal.
        assertEquals("`$share` and []($happy)", HappyShareLinks.rewrite("`$share` and $share", here))
        val fenced = "```\n$share\n```\n$share"
        assertEquals("```\n$share\n```\n[]($happy)", HappyShareLinks.rewrite(fenced, here))
        // The bare form is the caller's to choose.
        assertEquals("See <$happy|$share>.", HappyShareLinks.rewrite("See $share.", here) { target, written -> "<${target.url}|$written>" })
    }
}
