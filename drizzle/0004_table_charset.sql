-- 表级字符集与排序规则显式锁定（D55）：不依赖 db:create 先把库建对。
-- 0000–0003 保持原样；本迁移只改四张表的默认字符集，不改列定义，
-- 因此 0002 给 option1_value / option2_value 补的 utf8mb4_0900_bin 保持不变。
ALTER TABLE `categories` DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;--> statement-breakpoint
ALTER TABLE `products` DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;--> statement-breakpoint
ALTER TABLE `product_images` DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;--> statement-breakpoint
ALTER TABLE `product_variants` DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
