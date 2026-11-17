import type { SeedManifest } from './seed-manifest.ts'

/**
 * 占位商品清单（T2）：2–4 件商品跑通「schema → 迁移 → 种子」链路（D56）。
 * 素材阶段再扩到 4–8 件样本；未列入的商品与分类在导入时保持不动（D52）。
 */
export const SEED_MANIFEST: SeedManifest = {
  categories: [
    { slug: 'audio', name: '音频设备' },
    { slug: 'wearables', name: '智能穿戴' },
  ],
  products: [
    {
      slug: 'aurora-headphones',
      name: '极光降噪头戴耳机',
      categorySlug: 'audio',
      brand: '声屿',
      model: 'AUR-H1',
      rating: 4.8,
      sales: 1280,
      dimensions: [
        { name: '颜色', options: ['曜石黑', '雾白'] },
        { name: '版本', options: ['标准版', '降噪版'] },
      ],
      detail: [
        { type: 'text', text: '40mm 动圈单元配主动降噪，通勤与办公场景都能压住环境噪声。' },
        { type: 'image', path: '/images/products/aurora-headphones/2.webp', alt: '耳机侧面与耳罩细节' },
        { type: 'text', text: '可折叠头梁与记忆棉耳罩，长时间佩戴不夹头；随机附赠 3.5mm 音频线与 USB-C 充电线。' },
      ],
      images: [
        { path: '/images/products/aurora-headphones/1.webp', alt: '极光降噪头戴耳机正面' },
        { path: '/images/products/aurora-headphones/2.webp', alt: '耳机侧面与耳罩细节' },
        { path: '/images/products/aurora-headphones/3.webp', alt: '折叠后的耳机与收纳包' },
        { path: '/images/products/aurora-headphones/4.webp', alt: '耳机与随机配件' },
      ],
    },
    {
      slug: 'pulse-earbuds',
      name: '脉冲真无线耳机',
      categorySlug: 'audio',
      brand: '声屿',
      model: 'PLS-T2',
      rating: 4.6,
      sales: 860,
      dimensions: [
        { name: '颜色', options: ['月岩灰', '薄荷绿'] },
        { name: '充电盒', options: ['标准版', '无线充版'] },
      ],
      detail: [
        { type: 'text', text: '半入耳设计，单耳 4.2g；双麦克风通话降噪，地铁里也能听清。' },
        { type: 'image', path: '/images/products/pulse-earbuds/1.webp', alt: '脉冲真无线耳机与充电盒' },
        { type: 'text', text: '充电盒支持无线充电，单次续航 6 小时，配合充电盒共 24 小时。' },
      ],
      images: [
        { path: '/images/products/pulse-earbuds/1.webp', alt: '脉冲真无线耳机与充电盒' },
        { path: '/images/products/pulse-earbuds/2.webp', alt: '单只耳机内侧结构' },
        { path: '/images/products/pulse-earbuds/3.webp', alt: '充电盒开盖状态' },
        { path: '/images/products/pulse-earbuds/4.webp', alt: '耳机佩戴效果' },
      ],
    },
    {
      slug: 'orbit-watch',
      name: '轨道智能手表',
      categorySlug: 'wearables',
      brand: '时环',
      model: 'ORB-W3',
      rating: 4.7,
      sales: 430,
      dimensions: [
        { name: '表带', options: ['硅胶', '编织'] },
        { name: '表盘', options: ['42mm', '46mm'] },
      ],
      detail: [
        { type: 'text', text: '1.8 英寸 AMOLED 屏幕，支持全天心率与血氧监测。' },
        { type: 'image', path: '/images/products/orbit-watch/3.webp', alt: '手表表盘界面' },
        { type: 'text', text: '50 米防水，内置 GPS；典型使用场景续航 10 天。' },
      ],
      images: [
        { path: '/images/products/orbit-watch/1.webp', alt: '轨道智能手表正面' },
        { path: '/images/products/orbit-watch/2.webp', alt: '手表侧面按键' },
        { path: '/images/products/orbit-watch/3.webp', alt: '手表表盘界面' },
        { path: '/images/products/orbit-watch/4.webp', alt: '手表与磁吸充电线' },
      ],
    },
  ],
}
