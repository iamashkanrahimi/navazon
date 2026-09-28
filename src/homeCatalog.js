export const HOME_FEEDS = {
  ir: {
    key: 'ir',
    command: '/new',
    title: '🔥 جدیدترین آهنگ‌های ایرانی',
    backAction: 'hnew',
    origin: 'unknown',
  },
  foreign: {
    key: 'foreign',
    command: '/foreign',
    title: '🔥 جدیدترین آهنگ‌های خارجی',
    backAction: 'hnew',
    origin: 'foreign',
  },
  tr: {
    key: 'tr',
    command: '/turkish',
    title: '🔥 جدیدترین آهنگ‌های ترکی',
    backAction: 'hnew',
    origin: 'foreign',
  },
  ar: {
    key: 'ar',
    command: '/arabic',
    title: '🔥 جدیدترین آهنگ‌های عربی',
    backAction: 'hnew',
    origin: 'foreign',
  },
  day: {
    key: 'day',
    command: '/topday',
    title: '📥 پردانلودترین‌های امروز',
    backAction: 'htop',
    origin: 'unknown',
  },
  week: {
    key: 'week',
    command: '/topweek',
    title: '📥 پردانلودترین‌های هفته',
    backAction: 'htop',
    origin: 'unknown',
  },
};

export const CURATED_PLAYLISTS = [
  { key: 'pop', label: 'گلچین پاپ', pattern: /گلچین.*پاپ/u },
  { key: 'nostalgia', label: 'یادگاری', pattern: /یادگاری/u },
  { key: 'remix', label: 'ریمیکس', pattern: /ملوبیت.*ریمیکس|ریمیکس/u },
  { key: 'martik', label: 'مارتیک', pattern: /مارتیک/u },
  { key: 'gilaki', label: 'گیلکی', pattern: /گیلکی/u },
];

export function curatedPlaylistByKey(key) {
  return CURATED_PLAYLISTS.find(item => item.key === key) || null;
}
