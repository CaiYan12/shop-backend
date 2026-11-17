CREATE TABLE `product_images` (
	`id` int AUTO_INCREMENT NOT NULL,
	`product_id` int NOT NULL,
	`path` varchar(255) NOT NULL,
	`sort_order` int NOT NULL,
	`alt` varchar(255) NOT NULL,
	CONSTRAINT `product_images_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_images_product_id_path_unique` UNIQUE(`product_id`,`path`),
	CONSTRAINT `product_images_sort_order_check` CHECK(`product_images`.`sort_order` >= 0)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slug` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`category_id` int NOT NULL,
	`brand` varchar(64) NOT NULL,
	`model` varchar(64) NOT NULL,
	`rating` decimal(2,1) NOT NULL,
	`sales` int NOT NULL,
	`detail` json NOT NULL,
	`dimensions` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_slug_unique` UNIQUE(`slug`),
	CONSTRAINT `products_rating_check` CHECK(`products`.`rating` >= 0 AND `products`.`rating` <= 5),
	CONSTRAINT `products_sales_check` CHECK(`products`.`sales` >= 0)
);
--> statement-breakpoint
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `product_images_product_id_index` ON `product_images` (`product_id`);--> statement-breakpoint
CREATE INDEX `products_category_id_index` ON `products` (`category_id`);