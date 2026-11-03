// The Reference's own words in each language ANR supports (D162). Kind names, section names and
// filter values are each newsroom's config (reference.yaml, D170); only words every newsroom's
// Reference shares live here, plus the labels of Wikidata's properties.
import type { Language } from "@anr/core";

export interface ReferenceWords {
  reference: string;
  /** D164: imported text, shown as it was (and, outside Persian, machine-translated, D169). */
  imported: string;
  approximate: string;
  all: string;
  filter: string;
  clear: string;
  nothing: string;
  untranslated: string;
  count: string;
  urlTypes: Record<string, string>;
  telegramPost: (n: string) => string;
  onTelegram: string;
  related: string;
  facts: {
    date: string;
    authors: string;
    venue: string;
    citations: (n: string, source: string, asOf: string) => string;
    citationsLabel: string;
    affiliations: string;
  };
  /** Wikidata's properties, as a profile shows them (D162). */
  wikidata: {
    website: string;
    inception: string;
    dissolved: string;
    hq: string;
    founders: string;
    parent: string;
    developer: string;
    employer: string;
    replaces: string;
    aliases: string;
    ids: string;
    source: string;
  };
  text: string;
  excerpts: string;
  relatedWorks: string;
  references: string;
  citedBy: string;
  linkedFrom: string;
  sources: string;
  links: string;
  newer: string;
  older: string;
}

const en: ReferenceWords = {
  reference: "Reference",
  imported:
    "Imported from the old archive and machine-translated from Persian. Not checked by ANR's verifier.",
  approximate: "(approximate date)",
  all: "All",
  filter: "Filter",
  clear: "Clear filters",
  nothing: "Nothing here yet.",
  untranslated: "Parts of this entry are not translated yet and are shown in Persian.",
  count: "Entries",
  urlTypes: {
    official: "Official page",
    docs: "Official docs",
    repo: "Official repository",
    press: "Press report",
    wikipedia: "Wikipedia",
    other: "Source",
  },
  telegramPost: (n) => `Telegram post ${n}`,
  onTelegram: "On Telegram",
  related: "Related",
  facts: {
    date: "Date",
    authors: "Authors",
    venue: "Published in",
    citations: (n, source, asOf) =>
      `about ${n} citations on ${source}${asOf ? `, as of ${asOf}` : ""}`,
    citationsLabel: "Citations",
    affiliations: "Affiliations",
  },
  wikidata: {
    website: "Website",
    inception: "Founded",
    dissolved: "Dissolved",
    hq: "Headquarters",
    founders: "Founders",
    parent: "Part of",
    developer: "Developer",
    employer: "Worked at",
    replaces: "Took over",
    aliases: "Also known as",
    ids: "Elsewhere",
    source: "Facts from Wikidata (CC0)",
  },
  text: "Summary",
  excerpts: "Excerpts",
  relatedWorks: "Related",
  references: "What it cites that is in this Reference or the channel",
  citedBy: "What in this Reference builds on it",
  linkedFrom: "In this Reference",
  sources: "Sources",
  links: "Links",
  newer: "Newer",
  older: "Older",
};

const fa: ReferenceWords = {
  reference: "مرجع",
  imported: "از آرشیو قدیمی آمده است. بررسی‌کننده‌ی ANR این متن را نسنجیده است.",
  approximate: "(تاریخ تقریبی)",
  all: "همه",
  filter: "فیلتر",
  clear: "پاک کردن فیلترها",
  nothing: "هنوز چیزی اینجا نیست.",
  untranslated: "بخش‌هایی از این مدخل هنوز ترجمه نشده و به فارسی آمده است.",
  count: "مدخل",
  urlTypes: {
    official: "صفحه‌ی رسمی",
    docs: "مستندات رسمی",
    repo: "مخزن رسمی",
    press: "گزارش رسانه",
    wikipedia: "ویکی‌پدیا",
    other: "منبع",
  },
  telegramPost: (n) => `پیام تلگرام ${n}`,
  onTelegram: "در کانال تلگرام",
  related: "مرتبط با",
  facts: {
    date: "تاریخ",
    authors: "نویسنده‌ها",
    venue: "محل انتشار",
    citations: (n, source, asOf) =>
      `حدود ${n} ارجاع در ${source} (تقریبی${asOf ? `، تا ${asOf}` : ""})`,
    citationsLabel: "ارجاع‌ها",
    affiliations: "نهاد نویسنده‌ها",
  },
  wikidata: {
    website: "وب‌سایت",
    inception: "تأسیس",
    dissolved: "انحلال",
    hq: "مقر",
    founders: "بنیان‌گذاران",
    parent: "بخشی از",
    developer: "سازنده",
    employer: "محل کار",
    replaces: "جانشین",
    aliases: "نام‌های دیگر",
    ids: "جاهای دیگر",
    source: "داده‌ها از ویکی‌داده (CC0)",
  },
  text: "خلاصه‌ی فارسی",
  excerpts: "بریده‌هایی از متن",
  relatedWorks: "مرتبط‌ها",
  references: "ارجاع‌هایی که در این مرجع یا کانال آمده‌اند",
  citedBy: "آنچه در این مرجع بر پایه‌ی آن است",
  linkedFrom: "در این مرجع",
  sources: "منابع",
  links: "پیوندها",
  newer: "تازه‌تر",
  older: "قدیمی‌تر",
};

const tr: ReferenceWords = {
  ...en,
  reference: "Başvuru",
  imported:
    "Eski arşivden aktarıldı ve Farsçadan makine çevirisiyle çevrildi. ANR'nin doğrulayıcısı bu metni kontrol etmedi.",
  approximate: "(yaklaşık tarih)",
  all: "Tümü",
  filter: "Süz",
  clear: "Süzgeçleri temizle",
  nothing: "Burada henüz bir şey yok.",
  untranslated: "Bu maddenin bazı bölümleri henüz çevrilmedi ve Farsça gösteriliyor.",
  count: "Madde",
  related: "İlgili",
  wikidata: {
    website: "Web sitesi",
    inception: "Kuruluş",
    dissolved: "Kapanış",
    hq: "Merkez",
    founders: "Kurucular",
    parent: "Bağlı olduğu",
    developer: "Geliştirici",
    employer: "Çalıştığı yerler",
    replaces: "Devraldığı",
    aliases: "Diğer adları",
    ids: "Başka yerlerde",
    source: "Veriler Wikidata'dan (CC0)",
  },
  text: "Özet",
  excerpts: "Alıntılar",
  relatedWorks: "İlgili",
  linkedFrom: "Bu başvuruda",
  sources: "Kaynaklar",
  links: "Bağlantılar",
  newer: "Daha yeni",
  older: "Daha eski",
};

export const REFERENCE_WORDS: Record<Language, ReferenceWords> = { en, fa, tr };
