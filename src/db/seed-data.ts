import type { SeedManifest } from './seed-manifest.ts'

/**
 * 全量商品清单（T7）：10 件真实商品，逐件取自 shop-frontend 的素材清单
 * docs/assets/product-images.json（C26：audio 4 / peripherals 3 / displays 1 / wearables 2）。
 *
 * - 商品名、slug、品牌、型号与素材清单一致，图片路径与
 *   public/images/products/{slug}/1.webp…n.webp 一一对应，顺序即轮播顺序（D48）。
 * - 每件两个规格维度、每维两个选项，组合逐件定义，各自持有价格、原价与库存（D40、D43、D44）。
 * - 演示价参考清单的 suggestedDemoPrice，按规格组合上下浮动；评分与销量为演示值。
 * - 售罄演示集中在 dell-e2210f（D49、C50）；另有缺货组合与不可选组合各一处（C56）。
 */
export const SEED_MANIFEST: SeedManifest = {
  categories: [
    { slug: 'audio', name: '音频设备' },
    { slug: 'peripherals', name: '键盘外设' },
    { slug: 'displays', name: '显示设备' },
    { slug: 'wearables', name: '智能穿戴' },
  ],
  products: [
    {
      slug: 'airpods-max',
      name: 'Apple AirPods Max 头戴式降噪耳机',
      categorySlug: 'audio',
      brand: 'Apple',
      model: 'A2096',
      rating: 4.8,
      sales: 1280,
      dimensions: [
        { name: '颜色', options: ['深空灰', '银色'] },
        { name: '接口', options: ['Lightning', 'USB-C'] },
      ],
      variants: [
        { sku: 'APM-SG-LTN', option1Value: '深空灰', option2Value: 'Lightning', price: 3999, originalPrice: 4399, stock: 12 },
        { sku: 'APM-SG-USBC', option1Value: '深空灰', option2Value: 'USB-C', price: 4199, originalPrice: 4599, stock: 8 },
        // 银色 / Lightning 缺货：组合存在、库存 0，用于演示「缺货」状态（C56）。
        { sku: 'APM-SI-LTN', option1Value: '银色', option2Value: 'Lightning', price: 3999, originalPrice: 4399, stock: 0 },
        { sku: 'APM-SI-USBC', option1Value: '银色', option2Value: 'USB-C', price: 4199, originalPrice: 4599, stock: 15 },
      ],
      detail: [
        { type: 'text', text: '头戴式包耳设计，铝金属耳罩配记忆棉耳垫；数码旋钮用于调节音量与播放。' },
        { type: 'image', path: '/images/products/airpods-max/3.webp', alt: 'Apple AirPods Max 支架上 3/4 视角，可见数码旋钮与按键' },
        { type: 'text', text: '实拍为深空灰配色；随机附赠智能耳机套，收纳时自动进入低功耗状态。' },
      ],
      images: [
        { path: '/images/products/airpods-max/1.webp', alt: 'Apple AirPods Max 黑底 3/4 正面，耳罩与头梁材质' },
        { path: '/images/products/airpods-max/2.webp', alt: 'Apple AirPods Max 俯视平放，双耳罩与头梁全貌' },
        { path: '/images/products/airpods-max/3.webp', alt: 'Apple AirPods Max 支架上 3/4 视角，可见数码旋钮与按键' },
        { path: '/images/products/airpods-max/4.webp', alt: 'Apple AirPods Max 支架正面，桌面场景' },
        { path: '/images/products/airpods-max/5.webp', alt: 'Apple AirPods Max 零售包装盒正面' },
      ],
    },
    {
      slug: 'apple-earpods',
      name: 'Apple EarPods 有线耳机（Lightning）',
      categorySlug: 'audio',
      brand: 'Apple',
      model: 'MMTN2',
      rating: 4.5,
      sales: 5620,
      dimensions: [
        { name: '接口', options: ['Lightning', '3.5mm'] },
        { name: '包装', options: ['盒装', '简装'] },
      ],
      variants: [
        { sku: 'EARPODS-LTN-BOX', option1Value: 'Lightning', option2Value: '盒装', price: 149, originalPrice: 179, stock: 200 },
        { sku: 'EARPODS-LTN-SIMPLE', option1Value: 'Lightning', option2Value: '简装', price: 129, originalPrice: 149, stock: 120 },
        { sku: 'EARPODS-35-BOX', option1Value: '3.5mm', option2Value: '盒装', price: 149, originalPrice: 179, stock: 60 },
        { sku: 'EARPODS-35-SIMPLE', option1Value: '3.5mm', option2Value: '简装', price: 129, originalPrice: 149, stock: 80 },
      ],
      detail: [
        { type: 'text', text: '有线入耳式耳机，线控集成麦克风与音量按键，接听与切歌不必掏出手机。' },
        { type: 'image', path: '/images/products/apple-earpods/2.webp', alt: 'Apple EarPods 包装盒正面与耳机' },
        { type: 'text', text: '提供 Lightning 与 3.5mm 两种接头，包装分盒装与简装两档。' },
      ],
      images: [
        { path: '/images/products/apple-earpods/1.webp', alt: 'Apple EarPods 包装盒与耳机俯视' },
        { path: '/images/products/apple-earpods/2.webp', alt: 'Apple EarPods 包装盒正面与耳机' },
        { path: '/images/products/apple-earpods/3.webp', alt: 'Apple EarPods 耳机与线控平铺' },
        { path: '/images/products/apple-earpods/4.webp', alt: 'Apple EarPods 开盒竖构图，线材盘绕' },
        { path: '/images/products/apple-earpods/5.webp', alt: 'Apple EarPods 耳机 3/4 特写' },
      ],
    },
    {
      slug: 'sony-wh-1000xm3',
      name: 'Sony WH-1000XM3 无线降噪头戴耳机',
      categorySlug: 'audio',
      brand: 'Sony',
      model: 'WH-1000XM3',
      rating: 4.7,
      sales: 2140,
      dimensions: [
        { name: '颜色', options: ['黑色', '铂金银'] },
        { name: '版本', options: ['标准版', '含收纳包套装'] },
      ],
      variants: [
        { sku: 'XM3-BK-STD', option1Value: '黑色', option2Value: '标准版', price: 2299, originalPrice: 2899, stock: 25 },
        { sku: 'XM3-BK-CASE', option1Value: '黑色', option2Value: '含收纳包套装', price: 2499, originalPrice: 3099, stock: 10 },
        { sku: 'XM3-SV-STD', option1Value: '铂金银', option2Value: '标准版', price: 2299, originalPrice: 2899, stock: 6 },
        { sku: 'XM3-SV-CASE', option1Value: '铂金银', option2Value: '含收纳包套装', price: 2499, originalPrice: 3099, stock: 4 },
      ],
      detail: [
        { type: 'text', text: '头戴式无线降噪耳机，耳罩外壳带 NFC 标志，支持触碰配对。' },
        { type: 'image', path: '/images/products/sony-wh-1000xm3/3.webp', alt: 'Sony WH-1000XM3 3/4 视角，耳罩外壳与 NFC 标志' },
        { type: 'text', text: '机身按键包含电源与 NC/AMBIENT 切换，可在降噪与环境声之间切换。' },
      ],
      images: [
        { path: '/images/products/sony-wh-1000xm3/1.webp', alt: 'Sony WH-1000XM3 收纳包内俯视，耳机与线材' },
        { path: '/images/products/sony-wh-1000xm3/2.webp', alt: 'Sony WH-1000XM3 俯视平放，双耳罩与头梁' },
        { path: '/images/products/sony-wh-1000xm3/3.webp', alt: 'Sony WH-1000XM3 3/4 视角，耳罩外壳与 NFC 标志' },
        { path: '/images/products/sony-wh-1000xm3/4.webp', alt: 'Sony WH-1000XM3 正面，耳罩内侧与 NC/AMBIENT 按键' },
        { path: '/images/products/sony-wh-1000xm3/5.webp', alt: 'Sony WH-1000XM3 开包俯视，耳机与 USB-C 线' },
      ],
    },
    {
      slug: 'sony-wh-ch500',
      name: 'Sony WH-CH500 无线头戴耳机',
      categorySlug: 'audio',
      brand: 'Sony',
      model: 'WH-CH500',
      rating: 4.4,
      sales: 1870,
      dimensions: [
        { name: '颜色', options: ['蓝色', '黑色'] },
        { name: '连接', options: ['蓝牙', '蓝牙+NFC'] },
      ],
      variants: [
        { sku: 'CH500-BL-BT', option1Value: '蓝色', option2Value: '蓝牙', price: 499, originalPrice: 599, stock: 40 },
        { sku: 'CH500-BL-NFC', option1Value: '蓝色', option2Value: '蓝牙+NFC', price: 549, originalPrice: 649, stock: 12 },
        { sku: 'CH500-BK-BT', option1Value: '黑色', option2Value: '蓝牙', price: 499, originalPrice: 599, stock: 30 },
        // 黑色 / 蓝牙+NFC 缺货：组合存在、库存 0，用于演示「缺货」状态（C56）。
        { sku: 'CH500-BK-NFC', option1Value: '黑色', option2Value: '蓝牙+NFC', price: 549, originalPrice: 649, stock: 0 },
      ],
      detail: [
        { type: 'text', text: '轻量头戴式无线耳机，耳罩可旋转平放，便于随身收纳。' },
        { type: 'image', path: '/images/products/sony-wh-ch500/1.webp', alt: 'Sony WH-CH500 俯视平放，双耳罩全貌' },
        { type: 'text', text: '实拍为蓝色版本；头梁内侧标注型号，NFC 版本支持触碰配对。' },
      ],
      images: [
        { path: '/images/products/sony-wh-ch500/1.webp', alt: 'Sony WH-CH500 俯视平放，双耳罩全貌' },
        { path: '/images/products/sony-wh-ch500/2.webp', alt: 'Sony WH-CH500 头梁铭牌与耳罩特写' },
        { path: '/images/products/sony-wh-ch500/3.webp', alt: 'Sony WH-CH500 3/4 视角，SONY 标志与按键' },
        { path: '/images/products/sony-wh-ch500/4.webp', alt: 'Sony WH-CH500 3/4 视角，耳罩内侧海绵' },
      ],
    },
    {
      slug: 'keychron-k8',
      name: 'Keychron K8 无线机械键盘（87 键 TKL）',
      categorySlug: 'peripherals',
      brand: 'Keychron',
      model: 'K8',
      rating: 4.6,
      sales: 960,
      dimensions: [
        { name: '轴体', options: ['红轴', '茶轴'] },
        { name: '键帽', options: ['原装 PBT', 'Camel PBT 套装'] },
      ],
      variants: [
        { sku: 'K8-RED-PBT', option1Value: '红轴', option2Value: '原装 PBT', price: 599, originalPrice: 699, stock: 35 },
        { sku: 'K8-RED-CAMEL', option1Value: '红轴', option2Value: 'Camel PBT 套装', price: 799, originalPrice: 899, stock: 8 },
        { sku: 'K8-BROWN-PBT', option1Value: '茶轴', option2Value: '原装 PBT', price: 599, originalPrice: 699, stock: 22 },
        { sku: 'K8-BROWN-CAMEL', option1Value: '茶轴', option2Value: 'Camel PBT 套装', price: 799, originalPrice: 899, stock: 5 },
      ],
      detail: [
        { type: 'text', text: '87 键 TKL 布局，前缘可见 USB-C 接口与系统切换开关。' },
        { type: 'image', path: '/images/products/keychron-k8/2.webp', alt: 'Keychron K8 前缘 3/4，可见 USB-C 与系统切换开关' },
        { type: 'text', text: '原装为灰白 PBT 键帽；Camel 键帽套装为同一把键盘换装后的实拍。' },
      ],
      images: [
        { path: '/images/products/keychron-k8/1.webp', alt: 'Keychron K8 俯视全键盘，原装灰白 PBT 键帽' },
        { path: '/images/products/keychron-k8/2.webp', alt: 'Keychron K8 前缘 3/4，可见 USB-C 与系统切换开关' },
        { path: '/images/products/keychron-k8/3.webp', alt: 'Keychron K8 左上角 esc / F1-F4 特写' },
        { path: '/images/products/keychron-k8/4.webp', alt: 'Keychron K8 右侧方向键与功能键区特写' },
        { path: '/images/products/keychron-k8/5.webp', alt: 'Keychron K8 换装 Camel 键帽套装' },
      ],
    },
    {
      slug: 'logitech-g15',
      name: 'Logitech G15 游戏键盘',
      categorySlug: 'peripherals',
      brand: 'Logitech',
      model: 'G15',
      rating: 4.2,
      sales: 430,
      dimensions: [
        { name: '版本', options: ['初代', 'v2'] },
        { name: '成色', options: ['全新', '二手'] },
      ],
      variants: [
        { sku: 'G15-V1-NEW', option1Value: '初代', option2Value: '全新', price: 299, originalPrice: 399, stock: 5 },
        { sku: 'G15-V1-USED', option1Value: '初代', option2Value: '二手', price: 199, originalPrice: 299, stock: 12 },
        { sku: 'G15-V2-NEW', option1Value: 'v2', option2Value: '全新', price: 349, originalPrice: 449, stock: 6 },
        // v2 / 二手 不提供：两个选项都存在但没有对应组合行，用于演示「不可选」状态（C56）。
      ],
      detail: [
        { type: 'text', text: '带可编程 LCD 屏与多媒体按键区的游戏键盘，左侧为 G 键列。' },
        { type: 'image', path: '/images/products/logitech-g15/3.webp', alt: 'Logitech G15 可编程 LCD 屏特写' },
        { type: 'text', text: '实拍为银色面板配蓝色背光版本，左上角有 Logitech G15 标识。' },
      ],
      images: [
        { path: '/images/products/logitech-g15/1.webp', alt: 'Logitech G15 桌面场景，与 Apple 键盘并排' },
        { path: '/images/products/logitech-g15/2.webp', alt: 'Logitech G15 左上角品牌标识特写' },
        { path: '/images/products/logitech-g15/3.webp', alt: 'Logitech G15 可编程 LCD 屏特写' },
        { path: '/images/products/logitech-g15/4.webp', alt: 'Logitech G15 多媒体按键区特写' },
      ],
    },
    {
      slug: 'logitech-g613',
      name: 'Logitech G613 无线机械键盘',
      categorySlug: 'peripherals',
      brand: 'Logitech',
      model: 'G613',
      rating: 4.5,
      sales: 720,
      dimensions: [
        { name: '轴体', options: ['Romer-G 线性', 'Romer-G 段落'] },
        { name: '连接', options: ['Lightspeed 无线', '蓝牙'] },
      ],
      variants: [
        { sku: 'G613-LIN-LS', option1Value: 'Romer-G 线性', option2Value: 'Lightspeed 无线', price: 699, originalPrice: 799, stock: 18 },
        { sku: 'G613-LIN-BT', option1Value: 'Romer-G 线性', option2Value: '蓝牙', price: 649, originalPrice: 749, stock: 7 },
        { sku: 'G613-TAC-LS', option1Value: 'Romer-G 段落', option2Value: 'Lightspeed 无线', price: 699, originalPrice: 799, stock: 11 },
        { sku: 'G613-TAC-BT', option1Value: 'Romer-G 段落', option2Value: '蓝牙', price: 649, originalPrice: 749, stock: 6 },
      ],
      detail: [
        { type: 'text', text: '无线机械键盘，左侧 G1–G6 宏键列，附可拆卸掌托。' },
        { type: 'image', path: '/images/products/logitech-g613/3.webp', alt: 'Logitech G613 左侧视角，可见宏键列与掌托' },
        { type: 'text', text: '背面为电池仓与可调支架；支持 Lightspeed 无线与蓝牙两种连接。' },
      ],
      images: [
        { path: '/images/products/logitech-g613/1.webp', alt: 'Logitech G613 俯视全键盘，木桌面场景' },
        { path: '/images/products/logitech-g613/2.webp', alt: 'Logitech G613 G1-G6 宏键特写' },
        { path: '/images/products/logitech-g613/3.webp', alt: 'Logitech G613 左侧视角，可见宏键列与掌托' },
        { path: '/images/products/logitech-g613/4.webp', alt: 'Logitech G613 媒体控制键特写' },
        { path: '/images/products/logitech-g613/5.webp', alt: 'Logitech G613 背面，电池仓与支架' },
      ],
    },
    {
      slug: 'dell-e2210f',
      name: 'Dell E2210f 22 英寸液晶显示器',
      categorySlug: 'displays',
      brand: 'Dell',
      model: 'E2210f',
      rating: 4.3,
      sales: 310,
      dimensions: [
        { name: '支架', options: ['原装底座', '第三方升降臂'] },
        { name: '成色', options: ['全新', '官翻'] },
      ],
      variants: [
        // 四个有效组合库存全为 0：商品级「售罄」演示（D49、C50）。
        { sku: 'E2210F-BASE-NEW', option1Value: '原装底座', option2Value: '全新', price: 399, originalPrice: 499, stock: 0 },
        { sku: 'E2210F-BASE-REF', option1Value: '原装底座', option2Value: '官翻', price: 299, originalPrice: 399, stock: 0 },
        { sku: 'E2210F-ARM-NEW', option1Value: '第三方升降臂', option2Value: '全新', price: 459, originalPrice: 559, stock: 0 },
        { sku: 'E2210F-ARM-REF', option1Value: '第三方升降臂', option2Value: '官翻', price: 349, originalPrice: 449, stock: 0 },
      ],
      detail: [
        { type: 'text', text: '22 英寸液晶显示器，底部接口含电源、VGA 与 DVI。' },
        { type: 'image', path: '/images/products/dell-e2210f/3.webp', alt: 'Dell E2210f 底部接口特写：电源、VGA、DVI' },
        { type: 'text', text: '背面带 VESA 安装板，可换装第三方升降臂；实拍同时包含原装底座与升降臂状态。' },
      ],
      images: [
        { path: '/images/products/dell-e2210f/1.webp', alt: 'Dell E2210f 正面 3/4，Dell 标志与底座' },
        { path: '/images/products/dell-e2210f/2.webp', alt: 'Dell E2210f 背面 3/4，支架与 VESA 安装板' },
        { path: '/images/products/dell-e2210f/3.webp', alt: 'Dell E2210f 底部接口特写：电源、VGA、DVI' },
        { path: '/images/products/dell-e2210f/4.webp', alt: 'Dell E2210f 正背面平视，铭牌与接口' },
      ],
    },
    {
      slug: 'apple-watch-series-8',
      name: 'Apple Watch Series 8 智能手表（Nike 款）',
      categorySlug: 'wearables',
      brand: 'Apple',
      model: 'A2771',
      rating: 4.9,
      sales: 1540,
      dimensions: [
        { name: '表壳', options: ['41mm', '45mm'] },
        { name: '表带', options: ['运动型表带', 'Nike 运动表带'] },
      ],
      variants: [
        { sku: 'AWS8-41-SPORT', option1Value: '41mm', option2Value: '运动型表带', price: 2999, originalPrice: 3199, stock: 14 },
        { sku: 'AWS8-41-NIKE', option1Value: '41mm', option2Value: 'Nike 运动表带', price: 3199, originalPrice: 3399, stock: 6 },
        { sku: 'AWS8-45-SPORT', option1Value: '45mm', option2Value: '运动型表带', price: 3299, originalPrice: 3499, stock: 9 },
        { sku: 'AWS8-45-NIKE', option1Value: '45mm', option2Value: 'Nike 运动表带', price: 3499, originalPrice: 3699, stock: 4 },
      ],
      detail: [
        { type: 'text', text: '方形表壳配运动表带，随机附包装盒与磁吸充电线。' },
        { type: 'image', path: '/images/products/apple-watch-series-8/4.webp', alt: 'Apple Watch Series 8 表盘特写（Nike 表盘）' },
        { type: 'text', text: '实拍为午夜色运动表带与 Nike 表盘；表壳有 41mm 与 45mm 两种尺寸。' },
      ],
      images: [
        { path: '/images/products/apple-watch-series-8/1.webp', alt: 'Apple Watch Series 8 表体与包装盒俯视' },
        { path: '/images/products/apple-watch-series-8/2.webp', alt: 'Apple Watch Series 8 表体与包装盒竖构图' },
        { path: '/images/products/apple-watch-series-8/3.webp', alt: 'Apple Watch Series 8 表体斜置全貌' },
        { path: '/images/products/apple-watch-series-8/4.webp', alt: 'Apple Watch Series 8 表盘特写（Nike 表盘）' },
      ],
    },
    {
      slug: 'huawei-watch',
      name: 'Huawei Watch 智能手表（第一代）',
      categorySlug: 'wearables',
      brand: 'Huawei',
      model: 'W1',
      rating: 4.4,
      sales: 880,
      dimensions: [
        { name: '表壳', options: ['银色', '黑色'] },
        { name: '表带', options: ['真皮', '金属'] },
      ],
      variants: [
        { sku: 'HW-W1-SV-LEATHER', option1Value: '银色', option2Value: '真皮', price: 1299, originalPrice: 1499, stock: 20 },
        { sku: 'HW-W1-SV-METAL', option1Value: '银色', option2Value: '金属', price: 1499, originalPrice: 1699, stock: 5 },
        { sku: 'HW-W1-BK-LEATHER', option1Value: '黑色', option2Value: '真皮', price: 1299, originalPrice: 1499, stock: 13 },
        { sku: 'HW-W1-BK-METAL', option1Value: '黑色', option2Value: '金属', price: 1499, originalPrice: 1699, stock: 7 },
      ],
      detail: [
        { type: 'text', text: '圆形表壳，背面为心率传感器与钢印；表冠位于表体侧面。' },
        { type: 'image', path: '/images/products/huawei-watch/2.webp', alt: 'Huawei Watch 背面，心率传感器与钢印' },
        { type: 'text', text: '实拍为银色表壳配黑色真皮表带，另有金属表带版本。' },
      ],
      images: [
        { path: '/images/products/huawei-watch/1.webp', alt: 'Huawei Watch 正面 3/4，表盘与真皮表带' },
        { path: '/images/products/huawei-watch/2.webp', alt: 'Huawei Watch 背面，心率传感器与钢印' },
        { path: '/images/products/huawei-watch/3.webp', alt: 'Huawei Watch 立于桌面正视' },
        { path: '/images/products/huawei-watch/4.webp', alt: 'Huawei Watch 正面 3/4，消息通知界面' },
        { path: '/images/products/huawei-watch/5.webp', alt: 'Huawei Watch 侧面，表体厚度与表冠' },
      ],
    },
  ],
}
