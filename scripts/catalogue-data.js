/**
 * Catalogue definition shared by seed-catalogue.js and generate-product-images.js.
 * Collections are rows in the existing `categories` table (slug below). Top Wear / Bottom Wear /
 * Plus Size are categories; because `products` has a single category_slug column (the collection),
 * a product's categories are stored as slug tokens inside the existing `tags` column.
 */

const COLLECTIONS = {
  "Kovenik Premium": "ardenby-premium", // slug kept: URLs, orders and carts reference it
  "The Print Club": "the-print-club",
  "Epic Thread": "epic-thread",
  "Supreme Edition": "supreme-edition",
};

const CATEGORY_TAG = { "Top Wear": "top-wear", "Bottom Wear": "bottom-wear", "Plus Size": "plus-size" };

const SIZES = ["S", "M", "L", "XL", "XXL"];
const PLUS_SIZES = ["3XL", "4XL", "5XL"];

const WASH_COTTON =
  "Machine wash cold with similar colours, inside out. Do not bleach. Tumble dry low or line dry. Iron on low heat, never directly on the print.";
const WASH_DENIM = "Wash cold inside out with like colours. Do not bleach. Line dry. Iron on medium heat.";
const WASH_FLEECE = "Machine wash cold inside out. Do not bleach. Tumble dry low. Do not iron on the print.";

/**
 * Existing products: data is UPDATED in place (matched by slug), never recreated.
 * Prices and variants are left exactly as they are.
 */
const EXISTING = [
  {
    slug: "urban-oversized-black-tee",
    collection: "Kovenik Premium",
    categories: ["Top Wear"],
    fit: "Oversized",
    gsm: 240,
    flags: { limited: 0, bestSeller: 1, isNew: 0 },
  },
  {
    slug: "dtf-print-club",
    name: "DTF Print Club Tee",
    collection: "The Print Club",
    categories: ["Top Wear"],
    fit: "Oversized",
    gsm: 240,
    flags: { limited: 1, bestSeller: 1, isNew: 0 },
    // The current row holds placeholder text (FDFF / KLDD / DSSDD / SDSD); replace with real copy.
    description:
      "A heavyweight oversized tee carrying a high-density DTF graphic from The Print Club. Cut boxy with a dropped shoulder and a clean neck rib. Limited run, no restocks.",
    fabricDetails: "240 GSM combed cotton, bio-washed and pre-shrunk. High-density DTF print.",
    washCare: WASH_COTTON,
    tags: "dtf print, graphic tee, oversized, limited drop, streetwear, the print club, top-wear",
  },
  {
    slug: "natural-linen-essential-t-shirt",
    name: "Natural Linen Essential Tee",
    collection: "Kovenik Premium",
    categories: ["Top Wear"], // was wrongly filed under Plus Size
    fit: "Regular",
    gsm: 220,
    flags: { limited: 0, bestSeller: 1, isNew: 0 },
  },
  {
    slug: "mountain-sunset-printed-t-shirt",
    name: "Mountain Sunset Graphic Tee",
    collection: "Epic Thread",
    categories: ["Top Wear"],
    fit: "Regular",
    gsm: 220,
    flags: { limited: 0, bestSeller: 1, isNew: 0 },
  },
];

/** New products. `new` = one of the newest 8 (is_new). Print Club items are limited. */
const NEW_PRODUCTS = [
  {
    code: "OPP", name: "Off-White Puff Print Tee", collection: "The Print Club", categories: ["Top Wear"],
    fit: "Oversized", gsm: 240, mrp: 1599, price: 1299, color: "Off-White", fabric: "100% Cotton",
    coverage: "Front", limited: 1, bestSeller: 0, isNew: 0,
    type: "t-shirt", print: "a raised puff-print chest graphic in tonal ink",
    desc: "Raised puff print on a boxy off-white heavyweight tee. The graphic sits proud of the fabric for a tactile, studio-made finish. Limited run from The Print Club.",
  },
  {
    code: "WCH", name: "Washed Charcoal Heavyweight Tee", collection: "Supreme Edition", categories: ["Top Wear"],
    fit: "Oversized", gsm: 280, mrp: 1799, price: 1499, color: "Charcoal", fabric: "100% Cotton",
    coverage: "Front", limited: 0, bestSeller: 1, isNew: 0,
    type: "t-shirt", print: "a plain washed-charcoal tee with a small woven chest label",
    desc: "280 GSM garment-washed cotton with a lived-in charcoal fade. Structured shoulders and a thick rib collar keep the shape wash after wash.",
  },
  {
    code: "SDS", name: "Sand Drop-Shoulder Tee", collection: "Kovenik Premium", categories: ["Top Wear"],
    fit: "Oversized", gsm: 240, mrp: 1399, price: 1199, color: "Sand", fabric: "100% Cotton",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 1,
    type: "t-shirt", print: "a plain sand-coloured tee with no graphic",
    desc: "A warm sand essential cut with a dropped shoulder and a relaxed body. Soft combed cotton that drapes cleanly and layers easily.",
  },
  {
    code: "KWB", name: "Koi Wave Back-Print Tee", collection: "Epic Thread", categories: ["Top Wear"],
    fit: "Oversized", gsm: 240, mrp: 1499, price: 1199, color: "Black", fabric: "100% Cotton",
    coverage: "Back", limited: 0, bestSeller: 0, isNew: 1,
    type: "t-shirt", print: "a large back graphic of koi fish swimming through stylised waves in white and red ink, with a tiny front chest mark",
    desc: "A large koi-and-wave illustration runs across the back of this black oversized tee. Quiet from the front, loud when you walk away.",
  },
  {
    code: "HGH", name: "Heavyweight Grey Hoodie", collection: "Supreme Edition", categories: ["Top Wear"],
    fit: "Relaxed", gsm: 400, mrp: 2999, price: 2499, color: "Heather Grey", fabric: "Cotton Fleece",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 1,
    type: "pullover hoodie", print: "a plain heather-grey hoodie with a kangaroo pocket",
    desc: "400 GSM brushed-back fleece in heather grey with a double-layer hood and a deep kangaroo pocket. Built for cold evenings and daily rotation.",
  },
  {
    code: "BZH", name: "Black Zip-Up Hoodie", collection: "Kovenik Premium", categories: ["Top Wear"],
    fit: "Relaxed", gsm: 380, mrp: 2799, price: 2299, color: "Black", fabric: "Cotton Fleece",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 1,
    type: "zip-up hoodie", print: "a plain black full-zip hoodie with a matte zip",
    desc: "Full-zip hoodie in dense 380 GSM black fleece with a matte metal zip and ribbed cuffs. Clean, minimal and made to layer.",
  },
  {
    code: "OOS", name: "Olive Overshirt", collection: "Supreme Edition", categories: ["Top Wear"],
    fit: "Relaxed", gsm: null, mrp: 2499, price: 1999, color: "Olive", fabric: "Cotton Twill",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 1,
    type: "button-up overshirt", print: "a plain olive cotton-twill overshirt with two chest pockets",
    desc: "A structured olive cotton-twill overshirt with twin chest pockets and a relaxed boxy cut. Wear it open over a tee or buttoned up as a light jacket.",
  },
  {
    code: "CPS", name: "Chambray Polka Shirt", collection: "Kovenik Premium", categories: ["Top Wear"],
    fit: "Regular", gsm: null, mrp: 1999, price: 1599, color: "Blue", fabric: "Cotton Chambray",
    coverage: "All Over", limited: 0, bestSeller: 0, isNew: 1,
    type: "short-sleeve shirt", print: "a soft blue chambray shirt with a small white polka-dot pattern",
    desc: "Lightweight blue chambray with a fine white polka print and a camp collar. Easy to dress up or down through the warm months.",
  },
  {
    code: "BRC", name: "Black Relaxed Cargo Pants", collection: "Supreme Edition", categories: ["Bottom Wear"],
    fit: "Relaxed", gsm: null, mrp: 2499, price: 1999, color: "Black", fabric: "Cotton Twill",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 1,
    type: "cargo pants", print: "plain black relaxed cargo pants with large flap pockets",
    desc: "Relaxed black cargo pants in durable cotton twill with roomy flap pockets and an adjustable hem. Utility cut, clean finish.",
  },
  {
    code: "CWT", name: "Charcoal Wide-Leg Trousers", collection: "Kovenik Premium", categories: ["Bottom Wear"],
    fit: "Relaxed", gsm: null, mrp: 2299, price: 1899, color: "Charcoal", fabric: "Cotton Blend",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 0,
    type: "wide-leg trousers", print: "plain charcoal wide-leg pleated trousers",
    desc: "Wide-leg charcoal trousers with a single pleat and a high, comfortable rise. A sharper alternative to the usual cargo.",
  },
  {
    code: "WBJ", name: "Washed Blue Baggy Jeans", collection: "Epic Thread", categories: ["Bottom Wear"],
    fit: "Relaxed", gsm: null, mrp: 2699, price: 2199, color: "Washed Blue", fabric: "Cotton Denim",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 0, wash: WASH_DENIM,
    type: "baggy jeans", print: "plain washed-blue baggy jeans with plain unbranded back pockets, no logos, no tabs and no labels",
    desc: "Baggy washed-blue denim with a low-slung, straight-from-the-hip cut. Soft hand-feel and a faded finish that gets better with wear.",
  },
  {
    code: "HBJ", name: "Heavyweight Black Joggers", collection: "Kovenik Premium", categories: ["Bottom Wear"],
    fit: "Relaxed", gsm: 320, mrp: 1899, price: 1499, color: "Black", fabric: "Cotton Fleece",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 0, wash: WASH_FLEECE,
    type: "joggers", print: "plain black heavyweight joggers with an elasticated cuff",
    desc: "320 GSM brushed fleece joggers with a tapered leg, elasticated cuffs and a drawcord waist. The comfortable end of the wardrobe.",
  },
  {
    code: "OPP2", name: "Off-White Parachute Pants", collection: "Epic Thread", categories: ["Bottom Wear"],
    fit: "Relaxed", gsm: null, mrp: 2199, price: 1799, color: "Off-White", fabric: "Nylon Blend",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 0,
    type: "parachute pants", print: "plain off-white lightweight parachute pants with toggle hems",
    desc: "Lightweight off-white parachute pants with toggle hems and a balloon leg. Crisp, airy and easy to style with a heavy tee.",
  },
  {
    code: "PBE", name: "Plus Size Black Essential Tee", collection: "Kovenik Premium", categories: ["Plus Size", "Top Wear"],
    fit: "Regular", gsm: 240, mrp: 1399, price: 1199, color: "Black", fabric: "100% Cotton",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 0, plus: true,
    type: "t-shirt", print: "a plain black tee with a small woven chest label",
    desc: "Our black essential tee, cut properly in 3XL to 5XL rather than just scaled up. Heavyweight cotton with a regular fit and a steady neck rib.",
  },
  {
    code: "PGO", name: "Plus Size Graphic Oversized Tee", collection: "Epic Thread", categories: ["Plus Size", "Top Wear"],
    fit: "Oversized", gsm: 240, mrp: 1499, price: 1299, color: "Black", fabric: "100% Cotton",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 0, plus: true,
    type: "t-shirt", print: "a bold front chest graphic of an abstract mountain ridge in white and red ink",
    desc: "An oversized graphic tee proportioned for 3XL to 5XL, with a bold mountain-ridge print on the chest. Roomy through the body with a dropped shoulder.",
  },
  {
    code: "PRJ", name: "Plus Size Relaxed Joggers", collection: "Kovenik Premium", categories: ["Plus Size", "Bottom Wear"],
    fit: "Relaxed", gsm: 320, mrp: 1999, price: 1599, color: "Black", fabric: "Cotton Fleece",
    coverage: "Front", limited: 0, bestSeller: 0, isNew: 0, plus: true, wash: WASH_FLEECE,
    type: "joggers", print: "plain black relaxed joggers with an elasticated cuff",
    desc: "Relaxed fleece joggers cut for 3XL to 5XL with a wider thigh and a soft drawcord waist. Heavyweight 320 GSM and built to last.",
  },
];

/** The 8 newest products (is_new = 1, newest created_at) - a mix of tops, bottoms and plus size. */
const NEWEST_CODES = ["SDS", "KWB", "HGH", "BZH", "OOS", "CPS", "BRC", "PGO"];

const slugify = (s) =>
  String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

module.exports = {
  COLLECTIONS, CATEGORY_TAG, SIZES, PLUS_SIZES, WASH_COTTON, EXISTING, NEW_PRODUCTS, NEWEST_CODES, slugify,
};
