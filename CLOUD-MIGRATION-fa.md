# مهاجرت Navazon به Cloud

این نسخه برای Render + Neon ساخته شده و دیگر به روشن بودن MacBook وابسته نیست.

## داده‌های دائمی در Neon

- Catalog خواننده / آلبوم / آهنگ
- Telegram file_id cache
- تعداد ارسال‌ها، cache hit و source fetch
- Followها
- Session دکمه‌های Inline
- وضعیت و آمار Crawler

## متغیرهای محرمانه

`.env` هرگز داخل GitHub قرار نمی‌گیرد. تمام Secretها باید فقط داخل Environment Variables در Render وارد شوند.

## Crawler

یک سرویس Cron خارجی باید هر ۲ دقیقه `/crawler` را با Header زیر صدا بزند:

`Authorization: Bearer <CRAWLER_TOKEN>`

Crawler اگر در دو دقیقه‌ی اخیر کاربر فعال بوده یا صف MeloBot/Ahangify مشغول باشد، خودش اجرا را رد می‌کند.

## آمار

`/admin/stats` آمار Catalog، Audio cache، Follow و Crawler را برمی‌گرداند و فقط با `ADMIN_TOKEN` قابل دسترسی است.
