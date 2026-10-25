import Foundation

/// The system emoji the picker's Emoji tab offers for `emoji` overlays and
/// reaction bubbles, by category as the system keyboard groups them, and
/// the chips under the search field that search stickers by emoji.
enum StoryEmojiCatalog {
    struct Category {
        var name: String
        var emoji: [String]
    }

    static let chips = ["😂", "❤️", "👍", "🔥", "🎉", "😢", "😮", "😡", "🤔", "👋", "🙏", "😴"]

    static let categories: [Category] = [
        Category(name: Strings.Stories.emojiPeople, emoji: split("""
        😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 \
        😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 \
        😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 👻 👽 🤖 💩 😺 😸 😹 😻 👋 🤚 ✋ 🖖 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 👍 👎 ✊ \
        👊 👏 🙌 👐 🤲 🤝 🙏 💪 🧠 👀 👁️ 👅 👄 🫶
        """)),
        Category(name: Strings.Stories.emojiNature, emoji: split("""
        🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦎 🐙 🦑 🦀 \
        🐠 🐟 🐬 🐳 🦈 🐊 🐘 🦒 🦘 🐕 🐈 🌵 🎄 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🌸 🌼 🌻 🌹 🌷 🌞 🌝 🌚 🌙 ⭐️ 🌟 ⚡️ 🔥 🌈 ☀️ ⛅️ \
        ☁️ 🌧️ ⛈️ ❄️ ☃️ 🌊 💧
        """)),
        Category(name: Strings.Stories.emojiFood, emoji: split("""
        🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🌶️ 🥔 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🧇 🥓 🍔 🍟 🍕 🌭 🥪 🌮 \
        🌯 🥗 🍝 🍜 🍣 🍱 🍤 🍙 🍦 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍿 ☕️ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🍸 🍹 🍾
        """)),
        Category(name: Strings.Stories.emojiActivity, emoji: split("""
        ⚽️ 🏀 🏈 ⚾️ 🎾 🏐 🏉 🎱 🏓 🏸 🏒 ⛳️ 🏹 🎣 🥊 🛹 ⛸️ 🎿 🏂 🏋️ 🤸 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 \
        🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🧩
        """)),
        Category(name: Strings.Stories.emojiTravel, emoji: split("""
        🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚜 🛵 🏍️ 🚲 🛴 🚨 🚀 🛸 🚁 ✈️ 🛫 🛬 ⛵️ 🚤 🚢 ⚓️ 🗺️ 🗽 🗼 🏰 🎡 🎢 🏖️ 🏝️ 🏔️ ⛰️ 🌋 🏕️ 🏠 \
        🏡 🏢 🏬 🏥 🏦 🏨 ⛪️ 🌁 🌃 🏙️ 🌄 🌅 🌆 🌉 🎆 🎇
        """)),
        Category(name: Strings.Stories.emojiObjects, emoji: split("""
        ⌚️ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙️ ⏰ ⌛️ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 🛠️ ⚙️ 🧲 \
        🔫 💣 🧨 🔪 🛡️ 🔮 🧿 💈 🔭 🔬 💊 💉 🧬 🦠 🧹 🧺 🧻 🚽 🛁 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 🎁 🎈 🎏 🎀 🎊 🎉 ✉️ 📦 📝 📁 📅 📌 📎 \
        ✂️ 🔒 🔓
        """)),
        Category(name: Strings.Stories.emojiSymbols, emoji: split("""
        ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☯️ ♈️ ♉️ ♊️ ♋️ ♌️ ♍️ 🆗 🆒 🆕 🆓 ✅ ☑️ ✔️ ❌ ❎ ➕ \
        ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❔ ❕ ❗️ 〰️ 💯 🔞 📵 🚫 ⛔️ ⭕️ 🛑 💢 ♨️ 🔅 🔆 ⚠️ 🔱 ⚜️ 🔰 ♻️ 💤 🎵 🎶 💬 💭 🗯️ 🔔 🔕 🏁 🚩
        """)),
        Category(name: Strings.Stories.emojiFlags, emoji: split("""
        🏳️ 🏴 🏳️‍🌈 🏴‍☠️ 🇺🇸 🇬🇧 🇨🇦 🇦🇺 🇩🇪 🇫🇷 🇪🇸 🇮🇹 🇵🇹 🇳🇱 🇧🇪 🇨🇭 🇦🇹 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇮🇪 🇵🇱 🇺🇦 🇬🇪 🇹🇷 🇮🇱 🇮🇳 🇨🇳 🇯🇵 🇰🇷 🇧🇷 🇦🇷 🇲🇽 🇨🇱 🇿🇦 🇳🇬 🇪🇬
        """)),
    ]

    private static func split(_ text: String) -> [String] {
        text.split(whereSeparator: \.isWhitespace).map(String.init)
    }
}
