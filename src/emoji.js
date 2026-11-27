// Custom emoji from the Telegram pack "News Emoji"
// (id 1269403972611866648, short name NewsEmoji, 100 animations).
//
// Message text renders them with <tg-emoji emoji-id="…">fallback</tg-emoji>;
// inline buttons use the custom_emoji_id field. Both are accepted by the Bot
// API only if the bot owns a Fragment username or if the bot owner has a
// Telegram Premium subscription, so every send path has a plain-emoji fallback.
export const CUSTOM_EMOJI = Object.freeze({
  sparkle: { id: "5325547803936572038", fallback: "✨" },
  shop: { id: "5229064374403998351", fallback: "🛍" },
  profile: { id: "5391112412445288650", fallback: "🥸" },
  lock: { id: "5296369303661067030", fallback: "🔒" },
  daily: { id: "5413879192267805083", fallback: "🗓" },
  download: { id: "5406745015365943482", fallback: "⬇️" },
  info: { id: "5334544901428229844", fallback: "ℹ️" },
});

export function emojiId(name) {
  return CUSTOM_EMOJI[name]?.id;
}

export function emojiFallback(name) {
  return CUSTOM_EMOJI[name]?.fallback ?? "";
}

/** HTML fragment for message text, e.g. <tg-emoji emoji-id="…">🛍</tg-emoji> */
export function emojiTag(name) {
  const item = CUSTOM_EMOJI[name];
  return item ? `<tg-emoji emoji-id="${item.id}">${item.fallback}</tg-emoji>` : "";
}

/** Remove <tg-emoji> wrappers, keeping the plain emoji fallback. */
export function stripCustomEmoji(text) {
  return String(text ?? "").replace(/<tg-emoji\b[^>]*>(.*?)<\/tg-emoji>/gs, "$1");
}

/** Deep copy of reply_markup without custom_emoji_id fields. */
export function stripMarkupEmoji(markup) {
  if (!markup || typeof markup !== "object") return markup;
  if (Array.isArray(markup)) return markup.map((item) => stripMarkupEmoji(item));
  const copy = {};
  for (const [key, value] of Object.entries(markup)) {
    if (key === "custom_emoji_id") continue;
    copy[key] = stripMarkupEmoji(value);
  }
  return copy;
}
