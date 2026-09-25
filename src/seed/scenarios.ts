import type { RawJudgment } from "../ai/judge.ts";

export type Background = "wood" | "white" | "booth";

export type Drawing =
  | {
      kind: "cards";
      name: string;
      number: string;
      rarity: string;
      accent: string;
      count: number;
      sleeve: boolean;
      damage?: boolean;
      background: Background;
    }
  | {
      kind: "shirt";
      fill: string;
      tag: string;
      hood?: boolean;
      background: Background;
    }
  | {
      kind: "box";
      title: string;
      model: string;
      fill: string;
      sealed: boolean;
      crushed?: boolean;
      cars?: boolean;
      background: Background;
    }
  | {
      kind: "sneakers";
      fill: string;
      soleStain?: boolean;
      background: Background;
    };

export interface Scenario {
  shipmentId: string;
  customer: { id: string; name: string; email: string };
  category: string;
  declaredValue: number;
  items: Array<{ name: string; qty: number; color: string; size: string; note: string }>;
  customerImages: Drawing[];
  receivedImages: Drawing[];
  title: string;
  demo: RawJudgment;
}

const card = (over: Partial<Extract<Drawing, { kind: "cards" }>>): Drawing => ({
  kind: "cards",
  name: "Flame Drake",
  number: "025/165",
  rarity: "SR",
  accent: "#d9480f",
  count: 1,
  sleeve: true,
  background: "booth",
  ...over,
});

export const SCENARIOS: Scenario[] = [
  {
    shipmentId: "N-260923-001",
    customer: { id: "C-1001", name: "テスト商会A", email: "c1001@example.com" },
    category: "トレカ",
    declaredValue: 12000,
    items: [{ name: "Flame Drake 025/165 SR", qty: 1, color: "", size: "", note: "スリーブ入り" }],
    customerImages: [card({ background: "wood" })],
    receivedImages: [card({})],
    title: "トレカ・問題なし",
    demo: {
      overall: "OK",
      summary: "カード名・番号・レアリティ・枚数・状態が顧客写真と一致しています。",
      checks: [
        { item: "カードの一致", result: "OK", confidence: 0.96, reason: "カード名「Flame Drake」、番号 025/165、レアリティ SR が顧客写真と一致しています", evidence: ["顧客写真1", "現物写真1"] },
        { item: "枚数", result: "OK", confidence: 0.97, reason: "申告1枚に対して現物も1枚です", evidence: ["現物写真1"] },
        { item: "状態", result: "OK", confidence: 0.91, reason: "縁・角に白欠けや折れは見られません", evidence: ["現物写真1"] },
        { item: "保護材", result: "OK", confidence: 0.93, reason: "顧客写真と同じくスリーブに入っています", evidence: ["顧客写真1", "現物写真1"] },
      ],
      issues: [],
      observed_quantity: 1,
      additional_photos: [],
      skill_gaps: [],
    },
  },
  {
    shipmentId: "N-260923-002",
    customer: { id: "C-1003", name: "カードショップB", email: "c1003@example.com" },
    category: "トレカ",
    declaredValue: 18000,
    items: [{ name: "Aqua Fox 112/165 RR", qty: 3, color: "", size: "", note: "3枚セット" }],
    customerImages: [card({ name: "Aqua Fox", number: "112/165", rarity: "RR", accent: "#1c7ed6", count: 3, sleeve: false, background: "white" })],
    receivedImages: [card({ name: "Aqua Fox", number: "112/165", rarity: "RR", accent: "#1c7ed6", count: 2, sleeve: false })],
    title: "トレカ・枚数不足",
    demo: {
      overall: "NG",
      summary: "申告は3枚ですが、現物は2枚しかありません。",
      checks: [
        { item: "カードの一致", result: "OK", confidence: 0.93, reason: "「Aqua Fox」112/165 RR で顧客写真と一致しています", evidence: ["顧客写真1", "現物写真1"] },
        { item: "枚数", result: "NG", confidence: 0.95, reason: "申告3枚に対し、現物写真では重なりなく2枚しか確認できません", evidence: ["顧客写真1", "現物写真1"] },
        { item: "状態", result: "OK", confidence: 0.88, reason: "2枚とも縁・角に目立つ傷はありません", evidence: ["現物写真1"] },
      ],
      issues: [{ type: "数量不足", detail: "「Aqua Fox 112/165 RR」が申告3枚に対して2枚（1枚不足）", photo: "現物写真1" }],
      observed_quantity: 2,
      additional_photos: [],
      skill_gaps: [],
    },
  },
  {
    shipmentId: "N-260923-003",
    customer: { id: "C-1004", name: "コレクターC", email: "c1004@example.com" },
    category: "トレカ",
    declaredValue: 45000,
    items: [{ name: "Thunder Wolf 201/165 SAR", qty: 1, color: "", size: "", note: "ローダー入り" }],
    customerImages: [card({ name: "Thunder Wolf", number: "201/165", rarity: "SAR", accent: "#7048e8", background: "white" })],
    receivedImages: [card({ name: "Thunder Wolf", number: "201/165", rarity: "SAR", accent: "#7048e8", damage: true })],
    title: "トレカ・折れと白欠け",
    demo: {
      overall: "NG",
      summary: "カードは一致していますが、顧客写真になかった折れと縁の白欠けがあります。",
      checks: [
        { item: "カードの一致", result: "OK", confidence: 0.95, reason: "「Thunder Wolf」201/165 SAR で一致しています", evidence: ["顧客写真1", "現物写真1"] },
        { item: "枚数", result: "OK", confidence: 0.97, reason: "申告1枚に対して現物も1枚です", evidence: ["現物写真1"] },
        { item: "状態", result: "NG", confidence: 0.86, reason: "現物写真1の右上の角付近に折れ線、下の縁に白欠けがあります。顧客写真1には見られません", evidence: ["顧客写真1", "現物写真1"] },
        { item: "保護材", result: "OK", confidence: 0.84, reason: "スリーブに入っています", evidence: ["現物写真1"] },
      ],
      issues: [{ type: "汚破損", detail: "「Thunder Wolf 201/165 SAR」の右上の角付近に折れ線、下の縁に白欠け", photo: "現物写真1" }],
      observed_quantity: 1,
      additional_photos: [],
      skill_gaps: [],
    },
  },
  {
    shipmentId: "N-260923-004",
    customer: { id: "C-1005", name: "セレクトショップD", email: "c1005@example.com" },
    category: "アパレル",
    declaredValue: 8900,
    items: [{ name: "ロゴTシャツ", qty: 1, color: "ネイビー", size: "M", note: "新品・下げ札付き" }],
    customerImages: [{ kind: "shirt", fill: "#1f2f5c", tag: "SIZE M / NAVY", background: "white" }],
    receivedImages: [{ kind: "shirt", fill: "#c92a2a", tag: "SIZE M / RED", background: "booth" }],
    title: "アパレル・色違い",
    demo: {
      overall: "NG",
      summary: "申告はネイビーですが、届いたのは赤のTシャツです。",
      checks: [
        { item: "色・柄", result: "NG", confidence: 0.94, reason: "顧客写真1は紺、現物写真1は赤です。照明の差の範囲を超えており、下げ札の表記も RED です", evidence: ["顧客写真1", "現物写真1"] },
        { item: "サイズ", result: "OK", confidence: 0.9, reason: "下げ札の表記は M で申告と一致しています", evidence: ["現物写真1"] },
        { item: "状態", result: "OK", confidence: 0.85, reason: "汚れ・穴・ほつれは見られません", evidence: ["現物写真1"] },
        { item: "付属品・タグ", result: "OK", confidence: 0.82, reason: "下げ札が付いています", evidence: ["現物写真1"] },
      ],
      issues: [{ type: "色違い", detail: "「ロゴTシャツ」がネイビーではなく赤", photo: "現物写真1" }],
      observed_quantity: 1,
      additional_photos: [],
      skill_gaps: [],
    },
  },
  {
    shipmentId: "N-260923-005",
    customer: { id: "C-1006", name: "古着ストアE", email: "c1006@example.com" },
    category: "アパレル",
    declaredValue: 15000,
    items: [{ name: "プルオーバーパーカー", qty: 1, color: "グレー", size: "L", note: "" }],
    customerImages: [{ kind: "shirt", fill: "#868e96", tag: "SIZE L / GRAY", hood: true, background: "wood" }],
    receivedImages: [{ kind: "shirt", fill: "#868e96", tag: "SIZE L / GRAY", hood: true, background: "booth" }],
    title: "アパレル・問題なし",
    demo: {
      overall: "OK",
      summary: "色・サイズ・状態とも顧客写真と一致しています。",
      checks: [
        { item: "色・柄", result: "OK", confidence: 0.92, reason: "グレーで一致しています。背景の違いによる明るさの差のみです", evidence: ["顧客写真1", "現物写真1"] },
        { item: "サイズ", result: "OK", confidence: 0.93, reason: "タグ表記 L で申告と一致しています", evidence: ["現物写真1"] },
        { item: "状態", result: "OK", confidence: 0.9, reason: "汚れ・穴・ほつれは見られません", evidence: ["現物写真1"] },
      ],
      issues: [],
      observed_quantity: 1,
      additional_photos: [],
      skill_gaps: [],
    },
  },
  {
    shipmentId: "N-260923-006",
    customer: { id: "C-1002", name: "ホビーショップF", email: "c1002@example.com" },
    category: "おもちゃ",
    declaredValue: 9800,
    items: [{ name: "ROBO BUILDER X-01（未開封）", qty: 1, color: "", size: "", note: "初回特典カード付き" }],
    customerImages: [{ kind: "box", title: "ROBO BUILDER", model: "X-01", fill: "#2b8a3e", sealed: true, background: "white" }],
    receivedImages: [{ kind: "box", title: "ROBO BUILDER", model: "X-01", fill: "#2b8a3e", sealed: true, crushed: true, background: "booth" }],
    title: "おもちゃ・箱の角つぶれ（顧客別ルール）",
    demo: {
      overall: "NG",
      summary: "箱の右上の角がつぶれています。顧客C-1002のルールでは軽微でもNGです。",
      checks: [
        { item: "商品の一致", result: "OK", confidence: 0.95, reason: "「ROBO BUILDER X-01」で顧客写真と一致しています", evidence: ["顧客写真1", "現物写真1"] },
        { item: "箱の状態", result: "NG", confidence: 0.9, reason: "現物写真1の右上の角がつぶれています（顧客写真1にはない）。顧客別ルールにより軽微でもNGです", evidence: ["顧客写真1", "現物写真1"] },
        { item: "未開封・開封", result: "OK", confidence: 0.88, reason: "シュリンク包装が残っており未開封です", evidence: ["現物写真1"] },
        { item: "初回特典", result: "要確認", confidence: 0.5, reason: "未開封のため、特典カードの有無は外から確認できません", evidence: ["現物写真1"] },
      ],
      issues: [{ type: "汚破損", detail: "「ROBO BUILDER X-01」の箱の右上の角につぶれ", photo: "現物写真1" }],
      observed_quantity: 1,
      additional_photos: [],
      skill_gaps: ["未開封品で、特典の有無を外から確認できない場合の扱いが決まっていない"],
    },
  },
  {
    shipmentId: "N-260923-007",
    customer: { id: "C-1007", name: "トイショップG", email: "c1007@example.com" },
    category: "おもちゃ",
    declaredValue: 6500,
    items: [{ name: "Mini Racer Set（4台入り・未開封）", qty: 1, color: "", size: "", note: "" }],
    customerImages: [{ kind: "box", title: "MINI RACER SET", model: "4 CARS", fill: "#e8590c", sealed: true, cars: true, background: "wood" }],
    receivedImages: [{ kind: "box", title: "MINI RACER SET", model: "4 CARS", fill: "#e8590c", sealed: true, cars: true, background: "booth" }],
    title: "おもちゃ・問題なし",
    demo: {
      overall: "OK",
      summary: "商品・箱の状態・未開封とも顧客写真と一致しています。",
      checks: [
        { item: "商品の一致", result: "OK", confidence: 0.94, reason: "「MINI RACER SET」4台入りで一致しています", evidence: ["顧客写真1", "現物写真1"] },
        { item: "箱の状態", result: "OK", confidence: 0.9, reason: "つぶれ・破れ・水濡れ跡は見られません", evidence: ["現物写真1"] },
        { item: "未開封・開封", result: "OK", confidence: 0.91, reason: "シュリンク包装が残っています", evidence: ["現物写真1"] },
      ],
      issues: [],
      observed_quantity: 1,
      additional_photos: [],
      skill_gaps: [],
    },
  },
  {
    shipmentId: "N-260923-008",
    customer: { id: "C-1008", name: "スニーカーストアH", email: "c1008@example.com" },
    category: "スニーカー",
    declaredValue: 32000,
    items: [{ name: "ランニングシューズ（白）", qty: 1, color: "ホワイト", size: "26.5cm", note: "新品" }],
    customerImages: [{ kind: "sneakers", fill: "#f8f9fa", background: "white" }],
    receivedImages: [{ kind: "sneakers", fill: "#f8f9fa", soleStain: true, background: "booth" }],
    title: "靴・専用スキルなし",
    demo: {
      overall: "要確認",
      summary: "商品は一致しているように見えますが、靴専用の検品基準がないため人が確認してください。",
      checks: [
        { item: "商品の一致", result: "OK", confidence: 0.85, reason: "白のランニングシューズで、形とデザインが顧客写真と一致しています", evidence: ["顧客写真1", "現物写真1"] },
        { item: "数量", result: "OK", confidence: 0.95, reason: "左右1足です", evidence: ["現物写真1"] },
        { item: "色", result: "OK", confidence: 0.88, reason: "白で一致しています", evidence: ["顧客写真1", "現物写真1"] },
        { item: "形状・汚破損", result: "要確認", confidence: 0.6, reason: "ソールに薄い汚れのようなものがありますが、新品として許容できるかの基準がありません", evidence: ["現物写真1"] },
        { item: "サイズ", result: "要確認", confidence: 0.5, reason: "サイズタグが写っていないため確認できません", evidence: [] },
      ],
      issues: [],
      observed_quantity: 1,
      additional_photos: ["靴の内側のサイズタグ", "ソールのアップ"],
      skill_gaps: ["靴のサイズ表記（US / EU / cm）の照合方法", "新品のソールの汚れ・使用感の許容範囲", "靴箱の有無・状態の扱い"],
    },
  },
  {
    shipmentId: "N-260923-009",
    customer: { id: "C-1001", name: "テスト商会A", email: "c1001@example.com" },
    category: "アパレル",
    declaredValue: 4200,
    items: [{ name: "ロゴTシャツ", qty: 1, color: "ブラック", size: "L", note: "" }],
    customerImages: [{ kind: "shirt", fill: "#212529", tag: "SIZE L / BLACK", background: "wood" }],
    receivedImages: [{ kind: "shirt", fill: "#212529", tag: "SIZE L / BLACK", background: "booth" }],
    title: "アパレル・問題なし（同じ顧客の2件目）",
    demo: {
      overall: "OK",
      summary: "色・サイズ・状態とも顧客写真と一致しています。",
      checks: [
        { item: "色・柄", result: "OK", confidence: 0.93, reason: "ブラックで一致しています", evidence: ["顧客写真1", "現物写真1"] },
        { item: "サイズ", result: "OK", confidence: 0.92, reason: "下げ札の表記 L で一致しています", evidence: ["現物写真1"] },
        { item: "状態", result: "OK", confidence: 0.9, reason: "汚れ・穴・ほつれは見られません", evidence: ["現物写真1"] },
      ],
      issues: [],
      observed_quantity: 1,
      additional_photos: [],
      skill_gaps: [],
    },
  },
];
