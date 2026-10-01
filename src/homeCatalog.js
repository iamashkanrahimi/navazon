export const HOME_FEEDS = {
  ir: {
    key: 'ir',
    command: '/new',
    title: '🔥 تازه‌های ایرانی',
    backAction: 'hnew',
    origin: 'unknown',
  },
  foreign: {
    key: 'foreign',
    command: '/foreign',
    title: '🔥 تازه‌های خارجی',
    backAction: 'hnew',
    origin: 'foreign',
  },
  tr: {
    key: 'tr',
    command: '/turkish',
    title: '🔥 تازه‌های ترکی',
    backAction: 'hnew',
    origin: 'foreign',
  },
  ar: {
    key: 'ar',
    command: '/arabic',
    title: '🔥 تازه‌های عربی',
    backAction: 'hnew',
    origin: 'foreign',
  },
  day: {
    key: 'day',
    command: '/topday',
    title: '🏆 پردانلودهای امروز',
    backAction: 'htop',
    origin: 'unknown',
  },
  week: {
    key: 'week',
    command: '/topweek',
    title: '🏆 پردانلودهای این هفته',
    backAction: 'htop',
    origin: 'unknown',
  },
};

export const CURATED_PLAYLISTS = [
  { key: 'pop', label: 'گلچین پاپ', uiLabel: '✨ گلچین پاپ', pattern: /گلچین.*پاپ/u },
  { key: 'nostalgia', label: 'یادگاری', uiLabel: '🕰 یادگاری', pattern: /یادگاری/u },
  { key: 'remix', label: 'ریمیکس', uiLabel: '⚡️ ریمیکس', pattern: /ملوبیت.*ریمیکس|ریمیکس/u },
  { key: 'martik', label: 'مارتیک', uiLabel: '🎙 مارتیک', pattern: /مارتیک/u },
  { key: 'gilaki', label: 'گیلکی', uiLabel: '🌊 گیلکی', pattern: /گیلکی/u },
];

export function curatedPlaylistByKey(key) {
  return CURATED_PLAYLISTS.find(item => item.key === key) || null;
}
