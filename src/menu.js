import { emojiId, emojiTag } from "./emoji.js";
import { translate } from "./i18n.js";

function menuButton(language, emoji, key, callbackData) {
  const id = emojiId(emoji);
  return {
    text: translate(language, key),
    callback_data: callbackData,
    ...(id ? { custom_emoji_id: id } : {}),
  };
}

/**
 * Main menu text, matching the DeltaGram store bot layout:
 *
 *   🛍 Магазин — покупка звёзд, NFT юзернеймов, номеров и верификаций
 *   🔒 Мои номера — список ваших номеров, привязанных к аккаунту
 *   🥸 Профиль — ваш профиль
 */
export function mainMenuText(language) {
  const line = (emoji, key) => `${emojiTag(emoji)} ${translate(language, key)}`;
  return [
    line("shop", "menuShopLine"),
    line("lock", "menuNumbersLine"),
    line("profile", "menuProfileLine"),
  ].join("\n");
}

/**
 * Main menu keyboard:
 *
 *   [        Магазин        ]
 *   [ Профиль ][ Мои номера ]
 *   [   Ежедневная награда  ]
 *   [ Скачать ][  О боте    ]
 */
export function mainMenuKeyboard(language, { admin = false, downloadUrl = "" } = {}) {
  const rows = [
    [menuButton(language, "shop", "buttonShop", "menu:shop")],
    [
      menuButton(language, "profile", "buttonProfile", "menu:profile"),
      menuButton(language, "lock", "buttonNumbers", "menu:numbers"),
    ],
    [menuButton(language, "daily", "buttonDaily", "menu:daily")],
    [
      downloadUrl
        ? {
            text: translate(language, "buttonDownload"),
            url: downloadUrl,
            ...(emojiId("download") ? { custom_emoji_id: emojiId("download") } : {}),
          }
        : menuButton(language, "download", "buttonDownload", "menu:download"),
      menuButton(language, "info", "buttonAbout", "menu:about"),
    ],
  ];
  if (admin) rows.push([menuButton(language, null, "buttonAdmin", "admin:menu")]);
  return { inline_keyboard: rows };
}
