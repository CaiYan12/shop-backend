CREATE TABLE `product_variants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`product_id` int NOT NULL,
	`sku` varchar(64) NOT NULL,
	`option1_value` varchar(64) NOT NULL,
	`option2_value` varchar(64) NOT NULL,
	`price` decimal(10,2) NOT NULL,
	`original_price` decimal(10,2) NOT NULL,
	`stock` int NOT NULL,
	CONSTRAINT `product_variants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- drizzle-orm 0.45.4 的 mysql-core 列定义不支持逐列 collation，这里按 D42 / ADR 0001 手工补 ALTER：
-- 两个选项值列按字符码值比较（大小写与全半角敏感），其余列沿用库默认 utf8mb4_0900_ai_ci（D55）。
ALTER TABLE `product_variants` MODIFY COLUMN `option1_value` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` MODIFY COLUMN `option2_value` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;