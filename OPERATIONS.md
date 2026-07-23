# MİRAS topluluk altyapısı

Dinlenme, beğeni ve yorum verileri Neon PostgreSQL üzerinde tutulur. Üretim
ortamı `DATABASE_URL` ve en az 32 baytlık `COMMUNITY_SECRET` değişkenlerini
gerektirir.

## Şema

```sh
node --env-file=.vercel/.env.production.local scripts/migrate.mjs
```

Migration idempotenttir; yeni yayınlardan önce tekrar çalıştırılabilir.

## Yorum moderasyonu

Şüpheli yorumlar doğrudan yayımlanmaz, `pending` durumunda sıraya alınır.

```sh
node --env-file=.vercel/.env.production.local scripts/moderate-comments.mjs list
node --env-file=.vercel/.env.production.local scripts/moderate-comments.mjs approve YORUM_UUID
node --env-file=.vercel/.env.production.local scripts/moderate-comments.mjs remove YORUM_UUID
```

Onay veya kaldırma işlemleri sayaçları veritabanı tetikleyicileri üzerinden
atomik olarak günceller.
