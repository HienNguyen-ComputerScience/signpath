/**
 * SignPath Engine v3.0 — Template Matching
 * =========================================
 * Compares live hand landmarks against averaged reference templates.
 * No neural network, no ONNX. Pure geometric comparison.
 *
 * Dependencies (load via script tags BEFORE this file):
 *   - MediaPipe Holistic: https://cdn.jsdelivr.net/npm/@mediapipe/holistic/holistic.js
 *
 * Required files:
 *   - models/sign-templates.json  (built by build_templates.py)
 *   - models/model-config.json    (class list for curriculum)
 *
 * Usage:
 *   const engine = new SignPathEngine()
 *   await engine.init(videoElement)
 *   engine.on('score', data => console.log(data))
 *   engine.selectSign('Mẹ')
 *
 * Same API as v2 — drop-in replacement. No ONNX Runtime needed.
 */
;(function(global) {
'use strict'

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const VERSION = '3.0.0'
const TEMPLATES_PATH = 'models/sign-templates.json'
const TEMPLATES_PATH_GZ = 'models/sign-templates.json.gz'
const CONFIG_PATH = 'models/model-config.json'

// Preprocessing (must match build_templates.py exactly)
const NUM_FEATURES = 162
const POSE_IDX = [11, 12, 13, 14, 15, 16, 0]
const FACE_IDX = [1, 10, 152, 234, 454]
// [Leniency] Fix 3 — two-tier shoulder visibility. STRICT is the existing
// "both shoulders confidently visible" primary path. LOOSE is used by the
// new mid-path: if at least one shoulder clears LOOSE and the nose is
// visible, we estimate the missing shoulder by mirroring across the nose
// (approximate body symmetry, fine for signing). SHOULDER_VIS is kept as an
// alias for the old strict threshold so any older reference still compiles.
const SHOULDER_VIS_STRICT = 0.5
const SHOULDER_VIS_LOOSE = 0.3
const SHOULDER_VIS = SHOULDER_VIS_STRICT
const MIN_SHOULDER_W = 0.01
const MIN_PALM = 0.001

// Scoring
const COMPARE_INTERVAL_MS = 200  // how often to compare (ms)
const MIN_BUFFER_FRAMES = 15     // need this many frames before comparing
const MAX_BUFFER_FRAMES = 120    // rolling buffer cap

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE QUALITY TIERS
// ═══════════════════════════════════════════════════════════════════════════
// Two-tier system. "high" = VSL400 multi-signer templates (the historical
// default — numeric behaviour below matches the pre-tier v3 engine). "low" =
// supplementary single-signer templates where pose/face mirror one person's
// idiosyncrasies rather than the sign. For "low" we (a) reweight to emphasise
// hands over pose+face, (b) map similarity to score more generously, (c)
// lower the pass threshold. All three knobs are v1 guesses — tune against
// real low-tier data once it lands.

// [Leniency] Fix 2 — loosen the overall score curve for the 'high' tier.
// Whole-frame cosine of 0.80 (clearly-recognisable handshape with natural
// body variation) used to map to ~63%; the new floor/ceiling maps it to ~81.
// Pass/star thresholds are expressed in SCORE terms (70/88), not similarity,
// so keeping passAt:70 works — getting 70 now requires less cosine than before.
// Low-tier curve is untouched.
const SIM_THRESHOLDS = {
  high: { floor: 0.45, ceiling: 0.88, passAt: 70 },
  low:  { floor: 0.40, ceiling: 0.85, passAt: 55 },
}

// [Leniency] Fix 1 — dedicated finger-score curve, decoupled from the
// whole-frame curve. Finger sub-vectors are small (4 landmarks × 3 coords),
// so the cosine is dominated by a few noisy joints; a "clearly-recognisable"
// finger shape sits around 0.80 cosine, which is near-failure on the old
// high-tier curve. Tier-agnostic: a finger either looks right or it doesn't,
// independent of whether the template is multi-signer (high) or single-signer (low).
const FINGER_SIM_FLOOR = 0.40
const FINGER_SIM_CEILING = 0.85
const FINGER_SIM_WIDTH = FINGER_SIM_CEILING - FINGER_SIM_FLOOR  // 0.45

// Fix 1 v2 — one-handed detection via template motion only. If the template's
// non-dom hand barely moves across its 60 frames relative to its dom hand, the
// sign is linguistically one-handed and the non-dom data is a data-collection
// artifact (resting hand in frame). Skip non-dom comparison in that case,
// regardless of what the user's hands are doing.
// Threshold = 0.75 (was 0.3). See MOTION_RATIO_DISTRIBUTION.md — 87.2% accuracy
// on 39 hand-labeled signs, 172/400 templates classify as one-handed.
const NONDOM_MOTION_RATIO_THRESHOLD = 0.75

// Star thresholds per tier. High keeps the historical [50, 70, 88]. Low
// derives from passAt so a single constant controls the whole curve:
//   [passAt, passAt+15, passAt+25] → 0/1/2/3 stars at 0/55/70/80.
const STAR_THRESHOLDS_HIGH = [50, 70, 88]
const STAR_THRESHOLDS_LOW = [
  SIM_THRESHOLDS.low.passAt,
  SIM_THRESHOLDS.low.passAt + 15,
  SIM_THRESHOLDS.low.passAt + 25,
]

// Per-feature weight profiles for the weighted cosine. Layout is fixed by
// _buildFrame:
//   0..62   dominant hand     (21 landmarks × 3)   ← the sign itself
//   63..125 non-dominant hand (21 landmarks × 3)   ← the sign itself
//   126..146 pose subset      (7 landmarks  × 3)   ← signer idiosyncrasies
//   147..161 face subset      (5 landmarks  × 3)   ← signer idiosyncrasies
//
// Low tier: hand 1.5, pose/face 0.3 — heavy reweighting for single-signer
// templates whose pose/face mirror idiosyncrasies rather than the sign.
//
// High tier: hand 1.15, pose/face 0.7 — mild hand emphasis. Derived from
// SCORING_DIAGNOSIS_REPORT.md: whole-frame cosine can collapse even when
// hands are correct because pose+face hold 20-25% of template energy and
// amplify natural body-posture differences between the VSL400 mean signer
// and the current user. These values are conservative compared to low-tier —
// high-quality templates still deserve meaningful pose/face credit.
// TODO(v1.5): POSE_IDX contains wrist landmarks (15, 16) which are
// anatomically hand-adjacent but live in the pose band — revisit grouping
// once observability data (debug:score events) lands.

const WEIGHTS_HIGH = (() => {
  const w = new Float32Array(NUM_FEATURES)
  for (let i = 0;   i < 63;  i++) w[i] = 1.15  // dominant hand
  for (let i = 63;  i < 126; i++) w[i] = 1.15  // non-dominant hand
  for (let i = 126; i < 147; i++) w[i] = 0.7   // pose
  for (let i = 147; i < 162; i++) w[i] = 0.7   // face
  return w
})()

const WEIGHTS_LOW = (() => {
  const w = new Float32Array(NUM_FEATURES)
  for (let i = 0;   i < 63;  i++) w[i] = 1.5  // dominant hand
  for (let i = 63;  i < 126; i++) w[i] = 1.5  // non-dominant hand
  for (let i = 126; i < 147; i++) w[i] = 0.3  // pose
  for (let i = 147; i < 162; i++) w[i] = 0.3  // face
  return w
})()

// Precompute w[i]² once — the weighted-cosine formula needs them in the hot
// loop (400 templates × 60 frames × 162 features per compare cycle).
const WEIGHTS_SQ_HIGH = (() => {
  const w = new Float32Array(NUM_FEATURES)
  for (let i = 0; i < NUM_FEATURES; i++) w[i] = WEIGHTS_HIGH[i] * WEIGHTS_HIGH[i]
  return w
})()
const WEIGHTS_SQ_LOW = (() => {
  const w = new Float32Array(NUM_FEATURES)
  for (let i = 0; i < NUM_FEATURES; i++) w[i] = WEIGHTS_LOW[i] * WEIGHTS_LOW[i]
  return w
})()

// Finger landmark groups in dominant hand (offset 0, 21 landmarks × 3)
const FINGER_GROUPS = [
  {name: 'Thumb',  nameVi: 'Cái',   indices: [1,2,3,4]},
  {name: 'Index',  nameVi: 'Trỏ',   indices: [5,6,7,8]},
  {name: 'Middle', nameVi: 'Giữa',  indices: [9,10,11,12]},
  {name: 'Ring',   nameVi: 'Áp út', indices: [13,14,15,16]},
  {name: 'Pinky',  nameVi: 'Út',    indices: [17,18,19,20]},
]

// ═══════════════════════════════════════════════════════════════════════════
// I18N
// ═══════════════════════════════════════════════════════════════════════════

const STRINGS = {
  excellent:    {vi:'Xuất sắc!',        en:'Excellent!'},
  goodJob:      {vi:'Tốt lắm!',        en:'Good!'},
  gettingThere: {vi:'Đang tiến bộ',    en:'Getting there'},
  keepTrying:   {vi:'Cố gắng lên',     en:'Keep trying'},
  waiting:      {vi:'Đang chờ',        en:'Waiting'},
  showHand:     {vi:'Đưa tay vào camera.', en:'Show your hand.'},
  performing:   {vi:'Thực hiện ký hiệu…',  en:'Perform the sign…'},
  closestMatch: {vi:'Gần nhất: ',      en:'Closest match: '},
  thumbF:{vi:'Cái',en:'Thumb'},indexF:{vi:'Trỏ',en:'Index'},
  middleF:{vi:'Giữa',en:'Middle'},ringF:{vi:'Áp út',en:'Ring'},pinkyF:{vi:'Út',en:'Pinky'},
}

let _lang = 'vi'
function T(k) { return (STRINGS[k] || {})[_lang] || (STRINGS[k] || {}).en || k }

// ═══════════════════════════════════════════════════════════════════════════
// ENGLISH TRANSLATIONS
// ═══════════════════════════════════════════════════════════════════════════

const EN={
  'Một':'One','Hai':'Two','Ba':'Three','Bốn':'Four','Năm':'Five',
  'Sáu':'Six','Bảy':'Seven','Tám':'Eight','Chín':'Nine','Mười':'Ten',
  'Thứ hai':'Monday','Thứ ba':'Tuesday','Thứ tư':'Wednesday','Thứ năm':'Thursday',
  'Thứ sáu':'Friday','Thứ bảy':'Saturday','Chủ nhật':'Sunday',
  'Tháng một':'January','Tháng hai':'February','Tháng ba':'March',
  'Tháng tư':'April','Tháng năm':'May','Tháng sáu':'June',
  'Tháng bảy':'July','Tháng tám':'August','Tháng chín':'September',
  'Tháng mười':'October','Tháng mười một':'November','Tháng mười hai':'December',
  'Màu đỏ':'Red','Màu cam':'Orange','Màu vàng':'Yellow','Màu xanh lá cây':'Green',
  'Màu xanh da trời':'Blue','Màu tím':'Purple','Màu hồng':'Pink',
  'Màu nâu':'Brown','Màu đen':'Black','Màu trắng':'White',
  'Anh':'Older brother','Chị':'Older sister','Em':'Younger sibling',
  'Mẹ':'Mother','Bố':'Father','Con':'Child','Con gái':'Daughter','Con trai':'Son',
  'Cháu':'Grandchild','Cô':'Aunt (paternal)','Dì':'Aunt (maternal)',
  'Chú':'Uncle','Cậu':'Uncle (maternal)','Bác':'Uncle/Aunt (older)',
  'Ông nội':'Paternal grandfather','Bà nội':'Paternal grandmother',
  'Ông ngoại':'Maternal grandfather','Bà ngoại':'Maternal grandmother',
  'Vợ':'Wife','Chồng':'Husband','Gia đình':'Family','Họ hàng':'Relatives',
  'Mùa xuân':'Spring','Mùa hè':'Summer','Mùa thu':'Autumn','Mùa đông':'Winter',
  'Mùa mưa':'Rainy season','Mùa khô':'Dry season',
  'Mưa':'Rain','Nắng':'Sunny','Gió':'Wind','Nóng':'Hot','Lạnh':'Cold',
  'Mát mẻ':'Cool','Ấm':'Warm','Khô':'Dry','Ướt':'Wet','Thời tiết':'Weather',
  'Bây giờ':'Now','Giờ':'Hour','Phút':'Minute','Giây':'Second',
  'Ngày':'Day','Tháng':'Month','Thời gian':'Time',
  'Sớm':'Early','Trễ':'Late','Mới':'New','Cũ':'Old',
  'Buổi sáng':'Morning','Buổi trưa':'Noon','Buổi chiều':'Afternoon','Buổi tối':'Evening',
  'Bình minh':'Dawn','Hoàng hôn':'Dusk',
  'Nhà':'Home','Trường học':'School','Trường Đại học':'University',
  'Trường Cao đẳng':'College','Bệnh viện':'Hospital','Siêu thị':'Supermarket',
  'Chợ':'Market','Nhà hàng':'Restaurant','Công viên':'Park','Nhà sách':'Bookstore',
  'Công ty':'Company','Thành phố':'City','Ngân hàng':'Bank',
  'Rạp chiếu phim':'Cinema','Nhà trọ':'Guesthouse','Quán cà phê':'Cafe',
  'Việt Nam':'Vietnam','Thái Lan':'Thailand','Mỹ':'USA',
  'Trung Quốc':'China','Hàn Quốc':'Korea','Nhật Bản':'Japan',
  'Xe máy':'Motorbike','Xe đạp':'Bicycle','Ô tô':'Car','Xe buýt':'Bus',
  'Xe tải':'Truck','Taxi':'Taxi','Thuyền':'Boat','Máy bay':'Plane',
  'Trực thăng':'Helicopter','Tàu hỏa':'Train',
  'Con chó':'Dog','Con mèo':'Cat','Con gà':'Chicken','Con vịt':'Duck',
  'Con heo':'Pig','Con trâu':'Water buffalo','Con bò':'Cow','Con dê':'Goat',
  'Con thỏ':'Rabbit','Con rùa':'Turtle',
  'Phở':'Pho','Bún':'Rice noodles','Xôi':'Sticky rice','Bánh chưng':'Rice cake',
  'Bánh tét':'Cylindrical rice cake','Bánh xèo':'Vietnamese pancake',
  'Bánh bao':'Steamed bun','Kem':'Ice cream','Kẹo':'Candy','Mì gói':'Instant noodles',
  'Thịt':'Meat','Trứng':'Egg','Gạo':'Rice',
  'Nước':'Water','Sữa':'Milk','Bia':'Beer','Rượu':'Wine','Trà':'Tea','Cà phê':'Coffee',
  'Quả cam':'Orange','Quả chuối':'Banana','Quả dâu':'Strawberry','Quả dứa':'Pineapple',
  'Quả đào':'Peach','Quả đu đủ':'Papaya','Quả bơ':'Avocado','Quả xoài':'Mango',
  'Quả mận':'Plum','Quả dừa':'Coconut',
  'Ngọt':'Sweet','Chua':'Sour','Đắng':'Bitter','Cay':'Spicy','Mặn':'Salty',
  'Đậm':'Strong (flavor)','Nhạt':'Mild','Thơm':'Fragrant','Hôi':'Smelly','Ngon miệng':'Delicious',
  'Chào':'Hello','Cảm ơn':'Thank you','Xin lỗi':'Sorry','Xin':'Please',
  'Có':'Yes','Không':'No','Đồng ý':'Agree','Từ chối':'Refuse',
  'Muốn':'Want','Thích':'Like','Cho':'Give','Cần':'Need','Hứa':'Promise',
  'Hy vọng':'Hope','Giới thiệu':'Introduce',
  'Ăn':'Eat','Uống':'Drink','Ngủ':'Sleep','Chạy':'Run','Đi':'Go',
  'Viết':'Write','Đọc':'Read','Khóc':'Cry','Cười':'Laugh','Học':'Study',
  'Làm việc':'Work','Nấu':'Cook','Múa':'Dance','Hát':'Sing','Gọi':'Call',
  'Nghe':'Listen','Xem':'Watch','Nói':'Speak','Nói chuyện':'Talk','Tìm':'Search',
  'Thử':'Try','Nướng':'Grill','Ghét':'Hate','Yêu thương':'Love','Giúp đỡ':'Help',
  'Chơi cờ':'Play chess','Chụp hình':'Take photo','Khám bệnh':'Medical exam',
  'Tắm rửa':'Bathe','Rửa tay':'Wash hands','Rửa mặt':'Wash face',
  'Rửa chén':'Wash dishes','Gội đầu':'Wash hair','Giặt đồ':'Wash clothes',
  'Phơi đồ':'Dry clothes','Thức dậy':'Wake up','Làm bài tập':'Do homework',
  'Dừng lại':'Stop','Tiếp tục':'Continue','Thay đổi':'Change','Cung cấp':'Provide',
  'Mua bán':'Buy and sell','Nếm':'Taste','Ngửi':'Smell','Cảm thấy':'Feel',
  'Quan sát':'Observe','Chú ý':'Pay attention','Chết':'Die',
  'Bắt chước':'Imitate','Khoe khoang':'Show off','Mách':'Tell on','Cắm trại':'Camp',
  'Báo cáo':'Report','Vâng lời':'Obey','Nghỉ ngơi':'Rest','Tỉnh':'Awake',
  'Vui':'Happy','Buồn':'Sad','Sợ':'Scared','Mệt':'Tired','Giỏi':'Good at',
  'Khỏe':'Healthy','Ốm':'Sick','Đau':'Pain','Bận':'Busy','Dỗi':'Sulking',
  'Thèm':'Crave','Thú vị':'Interesting','Nhầm lẫn':'Confused',
  'Nặng':'Heavy','Nhẹ':'Light','Rộng':'Wide','Hẹp':'Narrow','Chật':'Cramped',
  'Dài':'Long','Ngắn':'Short','Nhanh':'Fast','Chậm chạp':'Slow',
  'Đắt':'Expensive','Rẻ':'Cheap','Giàu':'Rich','Nghèo':'Poor',
  'Sạch sẽ':'Clean','Dơ':'Dirty','Xa':'Far','Gần':'Near',
  'Hiền':'Gentle','Dữ':'Fierce','Ngoan':'Well-behaved','Hư':'Naughty',
  'Dũng cảm':'Brave','Thông minh':'Smart','Ngu ngốc':'Stupid',
  'Chăm chỉ':'Diligent','Lười biếng':'Lazy','Tốt bụng':'Kind-hearted',
  'Tham lam':'Greedy','Tham ăn':'Gluttonous','Hài hước':'Funny',
  'Yên tĩnh':'Quiet','Ồn ào':'Noisy','Mập':'Fat','Lùn':'Short (person)',
  'Già':'Old','Trẻ':'Young','Mạnh':'Strong','Yếu':'Weak',
  'Cứng':'Hard','Mềm':'Soft','Sáng tạo':'Creative','Hay (khen)':'Impressive',
  'Dở':'Bad','Khó':'Difficult','Dễ':'Easy','Sai':'Wrong','Đúng':'Correct',
  'Cao (người)':'Tall (person)','Cao (đồ vật)':'Tall (object)','Thấp (đồ vật)':'Short (object)',
  'Nên':'Should','Không nên':'Should not','Không cần':'Don\'t need',
  'Không cho':'Don\'t allow','Không nghe lời':'Disobedient','Không quen':'Unfamiliar',
  'Quen':'Familiar','Bắt buộc':'Mandatory','Đẹp (người)':'Beautiful (person)',
  'Đẹp (vật)':'Beautiful (object)','Xấu (người)':'Ugly (person)','Xấu (vật)':'Ugly (object)',
  'Sách':'Book','Vở':'Notebook','Bút bi':'Pen','Bút chì':'Pencil',
  'Cục tẩy':'Eraser','Bảng':'Board','Thước kẻ':'Ruler','Laptop':'Laptop',
  'Điện thoại':'Phone','Máy chiếu':'Projector','Bàn phím':'Keyboard',
  'Cái áo':'Shirt','Cái quần':'Pants','Áo thun':'T-shirt','Giày':'Shoes',
  'Mũ':'Hat','Ba lô':'Backpack','Túi xách':'Handbag',
  'Cái bàn':'Table','Cái ghế':'Chair','Tivi':'TV','Tủ lạnh':'Fridge',
  'Giường':'Bed','Chìa khóa':'Key',
  'Bóng đá':'Football','Bóng rổ':'Basketball','Bơi lội':'Swimming','Võ':'Martial arts',
  'Bác sĩ':'Doctor','Y tá':'Nurse','Ca sĩ':'Singer','Luật sư':'Lawyer',
  'Sinh viên':'Student','Học sinh':'Student','Nghề nghiệp':'Profession',
  'Tết Âm lịch':'Lunar New Year','Giáng sinh':'Christmas','Trung thu':'Mid-Autumn',
  'Ngày Nhà giáo Việt Nam':'Teachers\' Day','Ngày Quốc tế Phụ nữ':'Women\'s Day',
  'Ngày Quốc tế Lao động':'Labor Day','Ngày Quốc tế Thiếu nhi':'Children\'s Day',
}

function translateGloss(g) { return EN[g] || g }

// ═══════════════════════════════════════════════════════════════════════════
// CURRICULUM CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIES = [
  {id:'greetings',icon:'👋',color:'#e07a3a',goal:{vi:'Chào hỏi & cơ bản',en:'Greetings & Basics'},
   matches:['Chào','Cảm ơn','Xin lỗi','Xin','Có','Không','Đồng ý','Từ chối','Hứa','Hy vọng','Giới thiệu','Muốn','Thích','Cần','Cho','Không cần','Không cho','Không quen','Quen']},
  {id:'numbers',icon:'🔢',color:'#d4922a',goal:{vi:'Số đếm',en:'Numbers'},
   matches:['Một','Hai','Ba','Bốn','Năm','Sáu','Bảy','Tám','Chín','Mười']},
  {id:'colors',icon:'🎨',color:'#f59e0b',goal:{vi:'Màu sắc',en:'Colors'},prefixes:['Màu ']},
  {id:'days',icon:'📅',color:'#8b5cf6',goal:{vi:'Ngày trong tuần',en:'Days of the Week'},
   matches:['Thứ hai','Thứ ba','Thứ tư','Thứ năm','Thứ sáu','Thứ bảy','Chủ nhật']},
  {id:'months',icon:'🗓️',color:'#06b6d4',goal:{vi:'Tháng',en:'Months'},
   matches:['Tháng một','Tháng hai','Tháng ba','Tháng tư','Tháng năm','Tháng sáu','Tháng bảy','Tháng tám','Tháng chín','Tháng mười','Tháng mười một','Tháng mười hai']},
  {id:'family',icon:'👨‍👩‍👧',color:'#5a9a3c',goal:{vi:'Gia đình',en:'Family'},
   matches:['Anh','Chị','Em','Mẹ','Bố','Con','Con gái','Con trai','Cháu','Cô','Dì','Chú','Cậu','Bác','Ông nội','Bà nội','Ông ngoại','Bà ngoại','Vợ','Chồng','Gia đình','Họ hàng']},
  {id:'time',icon:'⏰',color:'#9b6b4a',goal:{vi:'Thời gian',en:'Time'},
   matches:['Bây giờ','Giờ','Phút','Giây','Ngày','Tháng','Thời gian','Sớm','Trễ','Mới','Cũ','Buổi sáng','Buổi trưa','Buổi chiều','Buổi tối','Bình minh','Hoàng hôn']},
  {id:'seasons',icon:'🌤️',color:'#0ea5e9',goal:{vi:'Mùa & Thời tiết',en:'Seasons & Weather'},
   matches:['Mùa xuân','Mùa hè','Mùa thu','Mùa đông','Mùa mưa','Mùa khô','Mưa','Nắng','Gió','Nóng','Lạnh','Mát mẻ','Ấm','Khô','Ướt','Thời tiết']},
  {id:'holidays',icon:'🎉',color:'#c9533a',goal:{vi:'Ngày lễ',en:'Holidays'},
   matches:['Tết Âm lịch','Giáng sinh','Trung thu','Ngày Nhà giáo Việt Nam','Ngày Quốc tế Phụ nữ','Ngày Quốc tế Lao động','Ngày Quốc tế Thiếu nhi']},
  {id:'places',icon:'🗺️',color:'#06b6d4',goal:{vi:'Địa điểm',en:'Places'},
   matches:['Nhà','Trường học','Trường Đại học','Trường Cao đẳng','Bệnh viện','Siêu thị','Chợ','Nhà hàng','Công viên','Nhà sách','Công ty','Thành phố','Ngân hàng','Rạp chiếu phim','Nhà trọ','Quán cà phê']},
  {id:'countries',icon:'🌏',color:'#c88b2e',goal:{vi:'Quốc gia',en:'Countries'},
   matches:['Việt Nam','Thái Lan','Mỹ','Trung Quốc','Hàn Quốc','Nhật Bản']},
  {id:'transport',icon:'🚗',color:'#f97316',goal:{vi:'Phương tiện',en:'Transportation'},
   matches:['Xe máy','Xe đạp','Ô tô','Xe buýt','Xe tải','Taxi','Thuyền','Máy bay','Trực thăng','Tàu hỏa']},
  {id:'animals',icon:'🐾',color:'#5a9a3c',goal:{vi:'Động vật',en:'Animals'},prefixes:['Con ']},
  {id:'fruits',icon:'🍎',color:'#ec4899',goal:{vi:'Trái cây',en:'Fruits'},prefixes:['Quả ']},
  {id:'food',icon:'🍜',color:'#d4922a',goal:{vi:'Món ăn',en:'Food'},
   matches:['Phở','Bún','Xôi','Bánh chưng','Bánh tét','Bánh xèo','Bánh bao','Kem','Kẹo','Mì gói','Thịt','Trứng','Gạo']},
  {id:'drinks',icon:'🥤',color:'#06b6d4',goal:{vi:'Đồ uống',en:'Drinks'},
   matches:['Nước','Sữa','Bia','Rượu','Trà','Cà phê']},
  {id:'tastes',icon:'👅',color:'#f59e0b',goal:{vi:'Vị giác',en:'Tastes'},
   matches:['Ngọt','Chua','Đắng','Cay','Mặn','Đậm','Nhạt','Thơm','Hôi','Ngon miệng']},
  {id:'emotions',icon:'😊',color:'#5a9a3c',goal:{vi:'Cảm xúc',en:'Emotions'},
   matches:['Vui','Buồn','Sợ','Mệt','Giỏi','Khỏe','Ốm','Đau','Bận','Dỗi','Thèm','Thú vị','Nhầm lẫn','Ghét','Yêu thương','Cảm thấy']},
  {id:'actions',icon:'🏃',color:'#9b6b4a',goal:{vi:'Hành động',en:'Actions'},
   matches:['Ăn','Uống','Ngủ','Chạy','Đi','Viết','Đọc','Khóc','Cười','Học','Làm việc','Nấu','Múa','Hát','Gọi','Nghe','Xem','Nói','Nói chuyện','Tìm','Thử','Nướng','Giúp đỡ','Chơi cờ','Chụp hình','Khám bệnh','Tắm rửa','Rửa tay','Rửa mặt','Rửa chén','Gội đầu','Giặt đồ','Phơi đồ','Thức dậy','Tỉnh','Làm bài tập','Dừng lại','Tiếp tục','Thay đổi','Cung cấp','Mua bán','Nếm','Ngửi','Quan sát','Chú ý','Chết','Bắt chước','Khoe khoang','Mách','Cắm trại','Báo cáo','Vâng lời','Nghỉ ngơi']},
  {id:'descriptions',icon:'📏',color:'#8b5cf6',goal:{vi:'Mô tả',en:'Descriptions'},
   matches:['Nặng','Nhẹ','Cao (người)','Cao (đồ vật)','Thấp (đồ vật)','Rộng','Hẹp','Chật','Dài','Ngắn','Nhanh','Chậm chạp','Đắt','Rẻ','Giàu','Nghèo','Sạch sẽ','Dơ','Đẹp (người)','Đẹp (vật)','Xấu (người)','Xấu (vật)','Xa','Gần','Hiền','Dữ','Ngoan','Hư','Dũng cảm','Thông minh','Ngu ngốc','Chăm chỉ','Lười biếng','Tốt bụng','Tham lam','Tham ăn','Hài hước','Yên tĩnh','Ồn ào','Mập','Lùn','Già','Trẻ','Mạnh','Yếu','Cứng','Mềm','Sáng tạo','Hay (khen)','Dở','Khó','Dễ','Sai','Đúng','Nên','Không nên','Không nghe lời','Bắt buộc']},
  {id:'clothes',icon:'👕',color:'#ec4899',goal:{vi:'Quần áo',en:'Clothing'},
   matches:['Cái áo','Cái quần','Áo thun','Áo đầm','Áo sơ mi','Quần đùi','Quần thun','Quần tây','Giày','Dép','Mũ','Mũ bảo hiểm','Khăn quàng cổ','Túi xách','Ba lô','Kẹp tóc','Vòng tay','Dây chuyền','Đồng hồ đeo tay','Đồ buộc tóc']},
  {id:'household',icon:'🏠',color:'#c88b2e',goal:{vi:'Đồ gia dụng',en:'Household'},
   matches:['Cái bàn','Cái ghế','Cái đèn','Cái nồi','Cái chảo','Cái cửa','Cửa sổ','Tường','Tivi','Tủ lạnh','Máy giặt','Máy điều hòa','Quạt (đứng)','Nồi cơm điện','Giường','Gối (đầu)','Mền','Chìa khóa','Đồ dùng']},
  {id:'school',icon:'📚',color:'#e07a3a',goal:{vi:'Đồ dùng học tập',en:'School Supplies'},
   matches:['Sách','Vở','Bút bi','Bút chì','Cục tẩy','Giấy nháp','Cái kéo','Kính lúp','Bảng','Viên phấn','Thước kẻ','Quả địa cầu','Dụng cụ học tập','Máy tính cầm tay','Laptop','Bàn phím','Điện thoại','Máy chiếu']},
  {id:'sports',icon:'⚽',color:'#5a9a3c',goal:{vi:'Thể thao',en:'Sports'},
   matches:['Bóng đá','Bóng chuyền','Bóng rổ','Bóng bàn','Điền kinh','Đá cầu','Bơi lội','Cầu lông','Nhảy dây','Nhảy cao','Võ','Thể dục (thể thao)']},
  {id:'occupations',icon:'💼',color:'#9b6b4a',goal:{vi:'Nghề nghiệp',en:'Occupations'},
   matches:['Bác sĩ','Y tá','Hiệu trưởng','Ca sĩ','Diễn viên','Nông dân','Bảo vệ','Đầu bếp','Giám đốc','Chủ tịch','Luật sư','Nhân viên văn phòng','Nhân viên phục vụ','Lễ tân','Thư ký','Kế toán','Sinh viên','Học sinh','Nghề nghiệp']},
]

// ═══════════════════════════════════════════════════════════════════════════
// MATH: Normalization + Comparison
// ═══════════════════════════════════════════════════════════════════════════

function _pickOrigin(pose, rHand, lHand) {
  if (pose && pose.length > 16) {
    const ls=pose[11], rs=pose[12], nose=pose[0]
    const lv=ls.visibility!=null?ls.visibility:1
    const rv=rs.visibility!=null?rs.visibility:1

    // PRIMARY: both shoulders confidently visible — unchanged legacy path.
    if (lv>SHOULDER_VIS_STRICT && rv>SHOULDER_VIS_STRICT) {
      const ox=(ls.x+rs.x)/2, oy=(ls.y+rs.y)/2, oz=((ls.z||0)+(rs.z||0))/2
      const s=Math.sqrt((ls.x-rs.x)**2+(ls.y-rs.y)**2+((ls.z||0)-(rs.z||0))**2)
      if (s>MIN_SHOULDER_W) return {ox,oy,oz,scale:s,refType:'shoulder'}
    }

    // [Leniency] Fix 3 — middle path. One shoulder partially visible + nose →
    // mirror the visible shoulder across the nose to estimate the cropped one.
    // Body symmetry holds well enough at signing distances; shoulders sit at
    // roughly the same y/z so we only mirror x. This keeps sitting / partially
    // cropped users in shoulder-normalised space instead of dropping them into
    // the palm-fallback coord system that templates can't be scored against.
    const nv = nose && nose.visibility != null ? nose.visibility : (nose ? 1 : 0)
    if (nose && nv > SHOULDER_VIS_STRICT) {
      const lLoose = lv > SHOULDER_VIS_LOOSE
      const rLoose = rv > SHOULDER_VIS_LOOSE
      if (lLoose ^ rLoose) {
        const visible = lLoose ? ls : rs
        const mirroredX = 2 * nose.x - visible.x
        // y/z mirrored through identity — shoulders roughly coplanar in the
        // camera frame at typical signing distances.
        const est = { x: mirroredX, y: visible.y, z: visible.z || 0 }
        const left = lLoose ? visible : est
        const right = lLoose ? est : visible
        const ox=(left.x+right.x)/2, oy=(left.y+right.y)/2, oz=((left.z||0)+(right.z||0))/2
        const s=Math.sqrt((left.x-right.x)**2+(left.y-right.y)**2+((left.z||0)-(right.z||0))**2)
        if (s>MIN_SHOULDER_W) return {ox,oy,oz,scale:s,refType:'shoulder_estimated'}
      }
    }
  }
  const h=rHand||lHand
  if (h&&h.length>=10) {
    const w=h[0],m=h[9]
    const s=Math.sqrt((m.x-w.x)**2+(m.y-w.y)**2+((m.z||0)-(w.z||0))**2)
    if (s>MIN_PALM) return {ox:w.x,oy:w.y,oz:w.z||0,scale:s,refType:'palm'}
  }
  return null
}

// outMeta: optional caller-supplied object that receives {refType: 'shoulder'|'palm'|'none'}.
// We surface the normalization mode so _onResults can track palm-fallback rate and warn
// the UI — templates live in shoulder-normalized space, so palm fallback means the user's
// frame lives in an incompatible coordinate system.
function _buildFrame(rHand, lHand, pose, face, outMeta) {
  const f=new Float32Array(NUM_FEATURES)
  const o=_pickOrigin(pose,rHand,lHand)
  if (outMeta) outMeta.refType = o ? o.refType : 'none'
  if (!o) return f
  const {ox,oy,oz,scale}=o

  // [Hand-Z] Browser MediaPipe Holistic emits hand landmark z in pose-space
  // depth; Python emits it relative to the hand's own wrist (wrist z = 0
  // exactly). Templates were built under the Python convention, so force the
  // same here: subtract each hand's own wrist z before the shoulder
  // normalization. This is a no-op for already-wrist-relative data (Python
  // side → wrist z = 0 → subtracting 0) and a correction on the browser side.
  // Without it, the dom-hand cosine collapses to ≈ -0.12 on face-involving
  // signs (Mẹ, Bố, Cảm ơn) even when the user's hand is correct — see
  // HAND_COORD_MISMATCH_REPORT.md.
  const rwZ = (rHand && rHand[0]) ? (rHand[0].z || 0) : 0
  const lwZ = (lHand && lHand[0]) ? (lHand[0].z || 0) : 0
  console.debug('[hand-z-fix]', { rwZ, lwZ, refType: o.refType })

  const n     = lm      => lm ? [((lm.x||0)-ox)/scale, ((lm.y||0)-oy)/scale, ((lm.z||0)-oz)/scale] : null
  const nHand = (lm,wz) => lm ? [((lm.x||0)-ox)/scale, ((lm.y||0)-oy)/scale, ((lm.z||0)-wz-oz)/scale] : null

  let dom=rHand, nonDom=lHand
  let domWZ=rwZ, nonDomWZ=lwZ
  if (!dom&&nonDom){dom=nonDom;nonDom=null;domWZ=lwZ;nonDomWZ=0}

  if (dom&&dom.length>=21) for(let i=0;i<21;i++){const v=nHand(dom[i],domWZ);if(v){f[i*3]=v[0];f[i*3+1]=v[1];f[i*3+2]=v[2]}}
  if (nonDom&&nonDom.length>=21) for(let i=0;i<21;i++){const v=nHand(nonDom[i],nonDomWZ);if(v){f[63+i*3]=v[0];f[63+i*3+1]=v[1];f[63+i*3+2]=v[2]}}
  if (pose&&pose.length>16) for(let i=0;i<POSE_IDX.length;i++){const v=n(pose[POSE_IDX[i]]);if(v){f[126+i*3]=v[0];f[126+i*3+1]=v[1];f[126+i*3+2]=v[2]}}
  if (face&&face.length>454) for(let i=0;i<FACE_IDX.length;i++){const v=n(face[FACE_IDX[i]]);if(v){f[147+i*3]=v[0];f[147+i*3+1]=v[1];f[147+i*3+2]=v[2]}}
  return f
}

function _resampleBuffer(buffer, targetLen) {
  const n = buffer.length
  // Bail cases — avoid shared Float32Array references and divide-by-zero
  if (n === 0) return Array.from({length: targetLen}, () => new Float32Array(NUM_FEATURES))
  if (n === 1) return Array.from({length: targetLen}, () => Float32Array.from(buffer[0]))
  if (targetLen === 1) return [Float32Array.from(buffer[Math.floor(n/2)])]
  if (n === targetLen) return buffer.slice()
  const result = []
  for (let i = 0; i < targetLen; i++) {
    const idx = i * (n - 1) / (targetLen - 1)
    const lo = Math.floor(idx), hi = Math.min(lo + 1, n - 1)
    const frac = idx - lo
    const frame = new Float32Array(NUM_FEATURES)
    for (let j = 0; j < NUM_FEATURES; j++) {
      frame[j] = buffer[lo][j] * (1 - frac) + buffer[hi][j] * frac
    }
    result.push(frame)
  }
  return result
}

function _cosineSimilarity(a, b, start, len) {
  // Cosine similarity between a[start..start+len] and b[start..start+len]
  let dot = 0, normA = 0, normB = 0
  for (let i = start; i < start + len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  normA = Math.sqrt(normA)
  normB = Math.sqrt(normB)
  if (normA < 1e-8 || normB < 1e-8) return 0
  return dot / (normA * normB)
}

function _frameNorm(frame, start, len) {
  let s = 0
  for (let i = start; i < start + len; i++) s += frame[i] * frame[i]
  return Math.sqrt(s)
}

function _frameWeightedNorm(frame, wSq, start, len) {
  // √Σ w[i]²·frame[i]². wSq is the precomputed squared-weights array.
  let s = 0
  for (let i = start; i < start + len; i++) s += wSq[i] * frame[i] * frame[i]
  return Math.sqrt(s)
}

function _cosineSimilarityWeightedPrenormed(a, b, wSq, start, len, normA, normB) {
  // Weighted cosine: Σ w[i]²·a[i]·b[i] / (normA·normB). normA/normB must be
  // the *weighted* norms (√Σ w²a²). With all-1 weights this reduces to plain
  // cosine — we deliberately use a single code path for both tiers so the
  // weighted path and any old unweighted path can't drift.
  if (normA < 1e-8 || normB < 1e-8) return 0
  let dot = 0
  for (let i = start; i < start + len; i++) dot += wSq[i] * a[i] * b[i]
  return dot / (normA * normB)
}

function _compareSequences(userFrames, templateMean, featureStart, featureLen) {
  // Average cosine similarity across frames for a feature range
  let totalSim = 0
  const nFrames = Math.min(userFrames.length, templateMean.length)
  for (let i = 0; i < nFrames; i++) {
    totalSim += _cosineSimilarity(userFrames[i], templateMean[i], featureStart, featureLen)
  }
  return totalSim / nFrames
}

// Weighted cosine over TWO disjoint feature ranges [s1,e1) ∪ [s2,e2). Used by
// Fix 1 (skip non-dominant-hand band for one-handed matches). Equivalent to
// _cosineSimilarityWeightedPrenormed but across two ranges, with the norms
// recomputed internally over only the ranges we care about.
function _cosineSimilarityWeightedMasked(a, b, wSq, s1, e1, s2, e2) {
  let dot = 0, nA = 0, nB = 0
  for (let i = s1; i < e1; i++) {
    dot += wSq[i] * a[i] * b[i]
    nA  += wSq[i] * a[i] * a[i]
    nB  += wSq[i] * b[i] * b[i]
  }
  for (let i = s2; i < e2; i++) {
    dot += wSq[i] * a[i] * b[i]
    nA  += wSq[i] * a[i] * a[i]
    nB  += wSq[i] * b[i] * b[i]
  }
  nA = Math.sqrt(nA); nB = Math.sqrt(nB)
  if (nA < 1e-8 || nB < 1e-8) return 0
  return dot / (nA * nB)
}

// [Fix 1 v2] Template-side one-handed detection. Measures the motion extent
// of the dom hand vs the non-dom hand across all template frames, returning
// nonDomMotion / domMotion. A low ratio (<0.3) means the non-dom hand barely
// moves relative to the dom hand — template represents a one-handed sign.
// A high ratio (>0.3) means both hands are active — genuinely two-handed.
//
// Extent per landmark: max(rangeX, rangeY, rangeZ) across the 60 frames.
// Averaged over 21 landmarks per hand.
//
// Edge case: if the dom hand itself is stationary (rare — static sign held
// in one position), the ratio is undefined; we return 1.0 to default to NOT
// skipping the non-dom band. Safe conservative behaviour for those signs.
function _computeNonDomMotionRatio(meanFrames) {
  const nFrames = meanFrames.length
  if (nFrames < 2) return 1.0

  function handMotionAvg(startFeature) {
    let totalExtent = 0
    for (let li = 0; li < 21; li++) {
      const base = startFeature + li * 3
      let minX = Infinity, maxX = -Infinity
      let minY = Infinity, maxY = -Infinity
      let minZ = Infinity, maxZ = -Infinity
      for (let f = 0; f < nFrames; f++) {
        const x = meanFrames[f][base]
        const y = meanFrames[f][base + 1]
        const z = meanFrames[f][base + 2]
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
      }
      totalExtent += Math.max(maxX - minX, maxY - minY, maxZ - minZ)
    }
    return totalExtent / 21
  }

  const domMotion = handMotionAvg(0)
  const nonDomMotion = handMotionAvg(63)

  // Dom hand barely moves → can't compute a meaningful ratio. Default to 1.0
  // (no skip) so static-sign templates fall through to full-frame scoring.
  if (domMotion < 0.01) return 1.0

  return nonDomMotion / domMotion
}

// Weighted band similarity: average per-frame weighted cosine over a single
// feature range. Used by Fix 3's debug:score event so UI/diagnostics can see
// which band is dragging down the whole-frame score.
function _compareSequencesWeightedBand(userFrames, templateMean, wSq, start, len) {
  const nFrames = Math.min(userFrames.length, templateMean.length)
  if (nFrames === 0) return 0
  let totalSim = 0
  for (let f = 0; f < nFrames; f++) {
    const a = userFrames[f], b = templateMean[f]
    let dot = 0, nA = 0, nB = 0
    for (let i = start; i < start + len; i++) {
      dot += wSq[i] * a[i] * b[i]
      nA  += wSq[i] * a[i] * a[i]
      nB  += wSq[i] * b[i] * b[i]
    }
    nA = Math.sqrt(nA); nB = Math.sqrt(nB)
    totalSim += (nA < 1e-8 || nB < 1e-8) ? 0 : dot / (nA * nB)
  }
  return totalSim / nFrames
}

function _simToScore(sim, quality) {
  // Map cosine similarity to 0-100 score. Quality is MANDATORY (no default):
  // calling with a missing tier must throw so a bug where a low-tier template
  // accidentally gets high-tier scoring fails loudly instead of silently.
  if (quality !== 'high' && quality !== 'low') {
    throw new Error(`_simToScore: quality must be 'high' or 'low', got ${JSON.stringify(quality)}`)
  }
  const t = SIM_THRESHOLDS[quality]
  if (sim <= t.floor) return 0
  if (sim >= t.ceiling) return 100
  return Math.round(((sim - t.floor) / (t.ceiling - t.floor)) * 100)
}

// [Leniency] Fix 1 — finger-specific score curve. Deliberately tier-agnostic:
// the whole-frame curve differs by tier because pose+face contribute, but a
// finger sub-vector is just the handshape itself, which deserves the same
// leniency regardless of which template set it came from.
function _fingerSimToScore(sim) {
  if (sim <= FINGER_SIM_FLOOR) return 0
  if (sim >= FINGER_SIM_CEILING) return 100
  return Math.round(((sim - FINGER_SIM_FLOOR) / FINGER_SIM_WIDTH) * 100)
}

function _starsForScore(score, quality) {
  if (quality !== 'high' && quality !== 'low') {
    throw new Error(`_starsForScore: quality must be 'high' or 'low', got ${JSON.stringify(quality)}`)
  }
  const t = quality === 'high' ? STAR_THRESHOLDS_HIGH : STAR_THRESHOLDS_LOW
  if (score >= t[2]) return 3
  if (score >= t[1]) return 2
  if (score >= t[0]) return 1
  return 0
}

function _normalizeQuality(raw) {
  // Accept 'high' or 'low'; anything else (missing, unknown string, null) →
  // 'high'. Keeps back-compat with older template files that have no quality
  // field and guards against typos in future hand-authored template JSON.
  return raw === 'low' ? 'low' : 'high'
}

// Try the gzipped template file first (Netlify serves it with
// Content-Encoding:gzip so the browser decodes transparently — fetch.json()
// just works). Fall back to the uncompressed JSON for local `python -m
// http.server` dev, which doesn't send Content-Encoding. When the .gz is
// served without that header we decode manually via DecompressionStream so
// a misconfigured host still works.
async function _loadTemplates(gzPath, rawPath) {
  try {
    const res = await fetch(gzPath)
    if (res.ok) {
      // Browsers strip Content-Encoding before JS can see it, so the header
      // is unreliable for detecting whether the body was auto-decompressed.
      // Try JSON first (works when the browser already decompressed); if
      // that fails the bytes are still gzip and we decompress manually.
      // clone() keeps res.body re-readable for the fallback path.
      try {
        return await res.clone().json()
      } catch (_) {
        if (typeof DecompressionStream === 'function') {
          const stream = res.body.pipeThrough(new DecompressionStream('gzip'))
          const text = await new Response(stream).text()
          return JSON.parse(text)
        }
      }
    }
  } catch (_) { /* fall through to raw */ }

  const res = await fetch(rawPath)
  if (!res.ok) throw new Error(`${rawPath} returned ${res.status}`)
  return await res.json()
}

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════

class SignPathEngine {
  constructor() {
    this._listeners = {}
    this._lang = 'vi'
    this._lessons = []
    this._signDB = {}
    this._progress = {}
    this._streak = 1
    this._lessonsCompleted = new Set()
    this._activeSign = null

    // Templates
    this._templates = {}       // gloss → {mean: Float32Array[], sampleCount, consistency}
    this._templateFrameCount = 0
    this._templatesReady = false

    // Frame buffer
    this._frameBuffer = []
    this._lastCompareTime = 0
    this._scoreBuffer = []
    this._smoothedScore = null

    // [M-2] carry-forward cache: when MediaPipe drops face/pose for a frame mid-sequence,
    // we reuse the previous frame's values for those feature slots instead of zero-filling
    // (which would drag cosine similarity toward zero for that frame).
    this._lastFrame = null

    // [Fix 3] Normalization observability. Last 30 frames' refType ('shoulder'|'palm'|'none');
    // when palm-fallback is firing > 20% of the time, the user's frame lives in a coordinate
    // system incompatible with shoulder-normalized templates. Emit 'tracking:degraded' to
    // let the UI warn the user. Rate-limited to one emit per 2000ms.
    this._originHistory = []        // rolling last 30 refTypes
    this._lastOriginRefType = null  // refType from the most recent frame (for debug:score)
    this._lastDegradedEmit = 0

    // MediaPipe
    this._holistic = null
    this._video = null
    this._running = false
    this._loopId = null
  }

  // ─── EVENTS ──────────────────────────────────────────────────────────

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(fn)
  }

  off(event, fn) {
    const arr = this._listeners[event]
    if (arr) this._listeners[event] = arr.filter(f => f !== fn)
  }

  _emit(event, data) {
    const arr = this._listeners[event]
    if (arr) arr.forEach(fn => { try { fn(data) } catch(e) { console.error(`[engine] ${event} error:`, e) } })
  }

  // ─── INIT ────────────────────────────────────────────────────────────

  async init(videoElement, opts = {}) {
    this._video = videoElement
    const templatesPath = opts.templatesPath || TEMPLATES_PATH
    const templatesPathGz = opts.templatesPathGz || TEMPLATES_PATH_GZ
    const configPath = opts.configPath || CONFIG_PATH

    // 1. Load templates — prefer the .gz (15% of raw size) when the server
    // serves it; fall back to raw JSON for local dev and old deploys.
    try {
      const data = await _loadTemplates(templatesPathGz, templatesPath)
      this._templateFrameCount = data.frameCount || 60
      // Convert template arrays to Float32Arrays for fast math + precompute
      // per-frame *weighted* norms that match the template's quality tier.
      // With all-1 weights the weighted norm equals the plain L2 norm, so
      // high-tier numeric behaviour is unchanged.
      for (const [gloss, tmpl] of Object.entries(data.templates)) {
        const mean = tmpl.mean.map(row => Float32Array.from(row))
        const quality = _normalizeQuality(tmpl.quality)
        const wSq = quality === 'low' ? WEIGHTS_SQ_LOW : WEIGHTS_SQ_HIGH
        const fullNorms = new Float32Array(mean.length)
        for (let f = 0; f < mean.length; f++) fullNorms[f] = _frameWeightedNorm(mean[f], wSq, 0, NUM_FEATURES)
        this._templates[gloss] = {
          mean,
          fullNorms,
          quality,
          sampleCount: tmpl.sampleCount,
          consistency: tmpl.consistency,
          // [Fix 1 v2] Cached once per template. Used by _compareAndScore to
          // decide whether to skip the non-dom-hand band when scoring.
          nonDomMotionRatio: _computeNonDomMotionRatio(mean),
        }
      }
      this._templatesReady = true
      console.log(`[engine] Loaded ${Object.keys(this._templates).length} templates (${this._templateFrameCount} frames each)`)

      // [Fix 1 v2] Classification summary — shows how many templates will
      // trigger skip-non-dom and whether known-one-handed signs classify
      // correctly. Worth watching in logs during development so miscalibrated
      // thresholds are visible without a full run of the app.
      const summary = { total: 0, oneHanded: 0, twoHanded: 0, staticDom: 0 }
      const specificSigns = ['Mẹ', 'Bố', 'Anh', 'Em', 'Cảm ơn', 'Xin lỗi', 'Xin', 'Năm']
      const specificResults = {}
      for (const [gloss, tmplEntry] of Object.entries(this._templates)) {
        summary.total++
        const r = tmplEntry.nonDomMotionRatio
        if (r === 1.0)                                   summary.staticDom++
        else if (r < NONDOM_MOTION_RATIO_THRESHOLD)      summary.oneHanded++
        else                                             summary.twoHanded++
        if (specificSigns.includes(gloss)) {
          specificResults[gloss] = {
            ratio: Math.round(r * 1000) / 1000,
            classified: r < NONDOM_MOTION_RATIO_THRESHOLD ? 'one-handed' : 'two-handed',
          }
        }
      }
      console.log('[engine] Template handedness classification:', summary)
      console.log('[engine] Specific signs:', specificResults)
    } catch(e) {
      this._emit('error', {message: `Templates failed: ${e.message}`, type: 'templates'})
      return
    }

    // 2. Build curriculum from template keys (no separate config needed, but load if available)
    const glosses = Object.keys(this._templates)
    this._buildCurriculum(glosses)

    // 3. Init + restore progress
    this._initProgress()
    this._restoreState()

    // 4. Camera
    let acquiredStream = null
    try {
      if (!videoElement.srcObject) {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          video: {width: 640, height: 480, facingMode: 'user'}
        })
        videoElement.srcObject = acquiredStream
      }
      await videoElement.play()
    } catch(e) {
      // Release camera if we acquired it before failing (e.g. play() rejected)
      if (acquiredStream) acquiredStream.getTracks().forEach(t => t.stop())
      videoElement.srcObject = null
      this._emit('error', {message: `Camera failed: ${e.message}`, type: 'camera'})
      return
    }

    // 5. MediaPipe Holistic
    try {
      await this._waitForGlobal('Holistic', 15000)
      this._holistic = new Holistic({
        locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${f}`
      })
      this._holistic.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        refineFaceLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      })
      this._holistic.onResults(r => this._onResults(r))
    } catch(e) {
      // Release camera since we're not going to use it
      if (videoElement.srcObject) {
        videoElement.srcObject.getTracks().forEach(t => t.stop())
        videoElement.srcObject = null
      }
      this._emit('error', {message: `MediaPipe failed: ${e.message}`, type: 'mediapipe'})
      return
    }

    // 6. Inference loop
    this._running = true
    this._inferenceRunning = false
    this._consecutiveErrors = 0
    this._lastSentTime = 0
    this._frameTimings = []  // [M-3] rolling FPS measurement
    this._startInferenceLoop()

    this._emit('ready', {
      templates: Object.keys(this._templates).length,
      lessons: this._lessons.length,
      signs: Object.keys(this._signDB).length,
    })
  }

  // ─── HOLISTIC RESULTS ────────────────────────────────────────────────

  _onResults(results) {
    const rHand = results.rightHandLandmarks || null
    const lHand = results.leftHandLandmarks || null
    const pose = results.poseLandmarks || null
    const face = results.faceLandmarks || null
    const raw = rHand || lHand
    const detected = !!raw

    // [Y-5] handedness debug log — remove once handedness contract is verified against Python extractor.
    // Uncomment to check: for a right-handed signer on a front-facing webcam,
    // which slot (rightHandLandmarks vs leftHandLandmarks) actually receives the dominant hand?
    // if (rHand && !this._handDebugged) { console.log('[engine] rHand wrist x:', rHand[0].x, '(expect <0.5 if user-right hand is screen-left)'); this._handDebugged = true }
    // if (lHand && !this._handDebuggedL) { console.log('[engine] lHand wrist x:', lHand[0].x); this._handDebuggedL = true }

    this._emit('tracking', {detected, rightHand:rHand, leftHand:lHand, pose, face, dominantHand:raw})

    if (!detected) {
      this._frameBuffer = []
      this._scoreBuffer = []
      this._lastFrame = null  // reset carry-forward cache on loss of track
      this._originHistory = []  // reset palm-fallback detection too
      if (this._activeSign) {
        this._emit('score', {
          score:0, signKey:this._activeSign,
          prediction:null, top3:[], fingerScores:[],
          feedback:T('showHand'), tier:T('waiting'), tierEmoji:'👋',
        })
      }
      return
    }

    // Only buffer + compare when a sign is selected and templates are ready
    if (!this._activeSign || !this._templatesReady) return

    // Build normalized feature vector for this frame (outMeta reports which
    // normalization path fired — 'shoulder' is primary, 'palm' means the
    // user's frame is in a coordinate system incompatible with templates).
    const frameMeta = { refType: 'none' }
    const frame = _buildFrame(rHand, lHand, pose, face, frameMeta)
    this._lastOriginRefType = frameMeta.refType

    // Rolling palm-fallback-rate detection (Fix 3)
    this._originHistory.push(frameMeta.refType)
    if (this._originHistory.length > 30) this._originHistory.shift()
    this._maybeEmitDegraded()

    // [M-2] Carry-forward: if face/pose dropped this frame but we had them last frame,
    // reuse the last values rather than zero-filling those slots.
    // - Dominant hand:   features 0..62    (always present when detected=true, no carry needed)
    // - Non-dominant:    features 63..125  (carry if missing here but present before)
    // - Pose:            features 126..146
    // - Face:            features 147..161
    if (this._lastFrame) {
      // Pose — if current pose data is missing (all zeros in pose region), carry forward
      if (!pose) for (let i = 126; i < 147; i++) frame[i] = this._lastFrame[i]
      // Face — same
      if (!face) for (let i = 147; i < 162; i++) frame[i] = this._lastFrame[i]
      // Non-dominant hand — only carry if template EXPECTS two hands AND user briefly lost it.
      // We can't easily tell from here, so leave it alone. If it's a two-handed sign and the user
      // loses their second hand, the deviations pipeline will flag that honestly.
    }
    this._lastFrame = frame

    // Add frame to buffer
    this._frameBuffer.push(frame)
    if (this._frameBuffer.length > MAX_BUFFER_FRAMES) this._frameBuffer.shift()

    // Throttled comparison
    const now = performance.now()
    if (now - this._lastCompareTime >= COMPARE_INTERVAL_MS && this._frameBuffer.length >= MIN_BUFFER_FRAMES) {
      this._lastCompareTime = now
      this._compareAndScore()
    }
  }

  // ─── TEMPLATE COMPARISON ─────────────────────────────────────────────

  _compareAndScore() {
    const key = this._activeSign
    if (!key) return

    // Resample user buffer to template frame count
    const userFrames = _resampleBuffer(this._frameBuffer, this._templateFrameCount)

    // Precompute user per-frame *weighted* norms — one array per tier we'll
    // actually need this cycle. Low-tier array is only built if any loaded
    // template is low-quality, so mono-tier deploys pay no extra cost.
    const userNormsHigh = new Float32Array(userFrames.length)
    for (let f = 0; f < userFrames.length; f++) {
      userNormsHigh[f] = _frameWeightedNorm(userFrames[f], WEIGHTS_SQ_HIGH, 0, NUM_FEATURES)
    }
    let userNormsLow = null
    for (const k in this._templates) {
      if (this._templates[k].quality === 'low') {
        userNormsLow = new Float32Array(userFrames.length)
        for (let f = 0; f < userFrames.length; f++) {
          userNormsLow[f] = _frameWeightedNorm(userFrames[f], WEIGHTS_SQ_LOW, 0, NUM_FEATURES)
        }
        break
      }
    }

    // Compare against ALL templates — each one is scored against its own
    // tier's weights and score mapping.
    const scores = []
    for (const [gloss, tmpl] of Object.entries(this._templates)) {
      const isLow = tmpl.quality === 'low'
      const wSq = isLow ? WEIGHTS_SQ_LOW : WEIGHTS_SQ_HIGH
      const userNorms = isLow ? userNormsLow : userNormsHigh
      const nFrames = Math.min(userFrames.length, tmpl.mean.length)
      let totalSim = 0
      for (let f = 0; f < nFrames; f++) {
        totalSim += _cosineSimilarityWeightedPrenormed(
          userFrames[f], tmpl.mean[f], wSq, 0, NUM_FEATURES,
          userNorms[f], tmpl.fullNorms[f]
        )
      }
      const sim = totalSim / nFrames
      const score = _simToScore(sim, tmpl.quality)
      scores.push({ gloss, similarity: sim, score, quality: tmpl.quality })
    }

    // Rank by SIMILARITY, not score. A low-tier template with a generous
    // score mapping must not leapfrog a higher-similarity high-tier one.
    scores.sort((a, b) => b.similarity - a.similarity)
    const top5 = scores.slice(0, 5)

    // Find selected sign's row
    const selectedEntry = scores.find(s => s.gloss === key)
    let selectedSim = selectedEntry ? selectedEntry.similarity : 0
    let rawScore = selectedEntry ? selectedEntry.score : 0
    const selectedQuality = selectedEntry
      ? selectedEntry.quality
      : (this._templates[key] ? this._templates[key].quality : 'high')
    const passAt = SIM_THRESHOLDS[selectedQuality].passAt

    // Per-finger scores + deviations are quality-aware (score mapping only;
    // finger cosine itself is unweighted because fingers live in one band).
    const fingerScores = this._computeFingerScores(userFrames, key, selectedQuality)
    const deviations = this._computeDeviations(userFrames, key, fingerScores, selectedQuality)

    // [Fix 1 v2] Skip non-dominant-hand band when the TEMPLATE represents a
    // one-handed sign — detected purely from template motion. If the template's
    // non-dom hand barely moves across its 60 frames relative to the dom hand,
    // the non-dom data is a data-collection artifact (signer's resting hand in
    // frame), not part of the sign's meaning. Skip it from the cosine.
    //
    // The user's hand state is irrelevant: for a one-handed sign, whether the
    // user has one hand, two hands, or is gesturing wildly with a second hand,
    // none of it affects the sign's correctness. The coach still receives the
    // original deviations.twoHanded fields and can comment separately.
    //
    // Top-5 ranking stays on full-frame cosine for apples-to-apples comparison
    // across all 400 templates. Missing nonDomMotionRatio → conservative
    // default to NOT skip (matches behaviour for minimal test mocks).
    const tmplRec = this._templates[key]
    let skippedNonDom = false
    const isOneHandedMatch = selectedEntry
      && tmplRec
      && typeof tmplRec.nonDomMotionRatio === 'number'
      && tmplRec.nonDomMotionRatio < NONDOM_MOTION_RATIO_THRESHOLD
    if (isOneHandedMatch) {
      const tmpl = tmplRec
      const isLow = tmpl.quality === 'low'
      const wSq = isLow ? WEIGHTS_SQ_LOW : WEIGHTS_SQ_HIGH
      const nFrames = Math.min(userFrames.length, tmpl.mean.length)
      let tot = 0
      for (let f = 0; f < nFrames; f++) {
        tot += _cosineSimilarityWeightedMasked(
          userFrames[f], tmpl.mean[f], wSq,
          0, 63,      // dominant hand
          126, 162,   // pose + face
        )
      }
      const maskedSim = nFrames ? tot / nFrames : 0
      selectedSim = maskedSim
      rawScore = _simToScore(maskedSim, selectedQuality)
      skippedNonDom = true
    }

    const rawPassed = rawScore >= passAt

    const selectedRank = scores.findIndex(s => s.gloss === key)
    const top1Sim = top5[0] ? top5[0].similarity : 0

    // [M-5]+quality: isMatch now prioritises pass-status. Passing the
    // selected sign's threshold is a stronger signal than out-ranking it
    // on a sub-threshold attempt. Note: isMatch's similarity-margin branches
    // still use the ORIGINAL selectedEntry.similarity (full-frame), since
    // ranking is full-frame. Only rawPassed is affected by the skip.
    const isMatch = rawPassed
      || selectedRank === 0
      || (selectedEntry && top1Sim - selectedEntry.similarity < 0.03)
      || (selectedRank >= 0 && selectedRank <= 2 && selectedEntry && selectedEntry.similarity > 0.7)

    // [Y-2] Exponential smoothing — more responsive than a rolling mean.
    const SCORE_ALPHA = 0.6
    this._smoothedScore = this._smoothedScore == null
      ? rawScore
      : this._smoothedScore * (1 - SCORE_ALPHA) + rawScore * SCORE_ALPHA
    const score = Math.round(this._smoothedScore)
    const passed = score >= passAt

    // Tier + feedback (cosmetic bands, uniform across quality tiers)
    let tier, tierEmoji, feedback
    if (score >= 80)      { tier=T('excellent');    tierEmoji='🎉' }
    else if (score >= 60) { tier=T('goodJob');      tierEmoji='👍' }
    else if (score >= 30) { tier=T('gettingThere'); tierEmoji='💪' }
    else                  { tier=T('keepTrying');   tierEmoji='🤔' }

    if (!isMatch && top5[0] && top5[0].score > 30) {
      feedback = T('closestMatch') + top5[0].gloss + ` (${top5[0].score}%)`
    } else {
      feedback = tier
    }

    this._emit('score', {
      score, signKey: key,
      prediction: top5[0] ? { gloss: top5[0].gloss, similarity: top5[0].similarity, score: top5[0].score, quality: top5[0].quality } : null,
      top3: top5.slice(0, 3).map(s => ({ gloss: s.gloss, score: s.score, similarity: s.similarity, quality: s.quality })),
      top5: top5.map(s => ({ gloss: s.gloss, score: s.score, similarity: s.similarity, quality: s.quality })),
      fingerScores,
      deviations,
      feedback, tier, tierEmoji,
      isMatch,
      quality: selectedQuality,
      passed,
      passAt,
      bufferFrames: this._frameBuffer.length,
    })

    // [Fix 3] Observability: emit per-band cosines whenever the selected sign's
    // similarity is suspiciously low. Lets the UI / diagnostics see WHICH band
    // (dom hand, non-dom hand, pose, face) is dragging down the whole-frame
    // score. Also lets a developer confirm whether the palm-fallback
    // coordinate-system mismatch is in play for an attempt.
    if (selectedEntry && selectedSim < 0.65) {
      const tmpl = this._templates[key]
      const isLow = tmpl.quality === 'low'
      const wSq = isLow ? WEIGHTS_SQ_LOW : WEIGHTS_SQ_HIGH
      this._emit('debug:score', {
        signKey: key,
        overallSim: selectedSim,
        overallScore: rawScore,
        perBandSim: {
          domHand:    _compareSequencesWeightedBand(userFrames, tmpl.mean, wSq,   0, 63),
          nonDomHand: _compareSequencesWeightedBand(userFrames, tmpl.mean, wSq,  63, 63),
          pose:       _compareSequencesWeightedBand(userFrames, tmpl.mean, wSq, 126, 21),
          face:       _compareSequencesWeightedBand(userFrames, tmpl.mean, wSq, 147, 15),
        },
        // [Fix 1 v2] Surface the handedness metric so live telemetry can
        // verify the skip-non-dom branch fires for the signs it should.
        nonDomMotionRatio: tmpl.nonDomMotionRatio,
        skipNonDomActivated: skippedNonDom,
        skippedNonDom,
        originFallbackActive: this._lastOriginRefType === 'palm',
        quality: selectedQuality,
      })
    }

    this._updateProgress(key, score)
  }

  // [Fix 3] Rate-check + emit palm-fallback warning. Extracted from _onResults
  // so unit tests can drive _originHistory directly without synthesizing
  // MediaPipe callbacks. Rate-limited to one emit per 2000ms.
  //
  // [Leniency] Fix 3 — only 'palm' is counted as degraded. 'shoulder_estimated'
  // (new mid-path for sitting / partially-cropped users) lives in the same
  // shoulder-normalised space as templates, so it's NOT a degraded coordinate
  // system and must not trigger the warning banner.
  _maybeEmitDegraded() {
    if (this._originHistory.length < 15) return
    let palmCount = 0
    for (const r of this._originHistory) if (r === 'palm') palmCount++
    const palmRate = palmCount / this._originHistory.length
    if (palmRate <= 0.20) return
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
    if (now - this._lastDegradedEmit <= 2000) return
    this._lastDegradedEmit = now
    this._emit('tracking:degraded', {
      reason: 'shoulders_not_visible',
      palmFallbackRate: Math.round(palmRate * 100) / 100,
    })
  }

  _computeFingerScores(userFrames, gloss, quality) {
    const tmpl = this._templates[gloss]
    if (!tmpl) return []
    // Quality is mandatory — per-finger scores need the same score mapping
    // as the whole-frame comparison or the two will disagree for the user.
    if (quality !== 'high' && quality !== 'low') {
      throw new Error(`_computeFingerScores: quality must be 'high' or 'low', got ${JSON.stringify(quality)}`)
    }

    return FINGER_GROUPS.map(fg => {
      // Each finger: 4 landmarks × 3 coords = 12 floats in the dominant hand section.
      // Cosine here is UNweighted because every feature lives in a single
      // weight band (the dominant-hand band) — multiplying a and b by the
      // same constant cancels in cosine. Only the sim→score mapping differs
      // by quality, which is what makes finger scores consistent with the
      // main score for low-tier templates.
      let totalSim = 0
      const nFrames = Math.min(userFrames.length, tmpl.mean.length)
      for (let f = 0; f < nFrames; f++) {
        let dot = 0, nA = 0, nB = 0
        for (const li of fg.indices) {
          for (let c = 0; c < 3; c++) {
            const a = userFrames[f][li * 3 + c]
            const b = tmpl.mean[f][li * 3 + c]
            dot += a * b; nA += a * a; nB += b * b
          }
        }
        nA = Math.sqrt(nA); nB = Math.sqrt(nB)
        totalSim += (nA > 1e-8 && nB > 1e-8) ? dot / (nA * nB) : 0
      }
      const sim = totalSim / nFrames
      return {
        name: _lang === 'vi' ? fg.nameVi : fg.name,
        // [Leniency] Fix 1 — the finger curve ignores `quality`; the mapping
        // is the same for both tiers. `quality` is still validated at the
        // function boundary (above) so misuse fails loud.
        score: _fingerSimToScore(sim),
        similarity: sim,
      }
    })
  }

  _computeDeviations(userFrames, gloss, fingerScores, quality) {
    const tmpl = this._templates[gloss]
    if (!tmpl || !userFrames.length) return null
    // quality defaults to the template's stored tier if caller didn't pass one.
    if (quality == null) quality = tmpl.quality || 'high'

    const nFrames = Math.min(userFrames.length, tmpl.mean.length)
    // Use the middle portion of frames (most likely to be the sign's core)
    const midStart = Math.floor(nFrames * 0.3)
    const midEnd = Math.floor(nFrames * 0.7)
    const midCount = midEnd - midStart || 1

    // ── Hand position deviation (wrist = landmark 0, features 0-2) ──
    let userWristX=0, userWristY=0, userWristZ=0
    let tmplWristX=0, tmplWristY=0, tmplWristZ=0
    for (let f = midStart; f < midEnd; f++) {
      userWristX += userFrames[f][0]; userWristY += userFrames[f][1]; userWristZ += userFrames[f][2]
      tmplWristX += tmpl.mean[f][0]; tmplWristY += tmpl.mean[f][1]; tmplWristZ += tmpl.mean[f][2]
    }
    userWristX/=midCount; userWristY/=midCount; userWristZ/=midCount
    tmplWristX/=midCount; tmplWristY/=midCount; tmplWristZ/=midCount

    const xErr = userWristX - tmplWristX  // positive = too far right
    const yErr = userWristY - tmplWristY  // positive = too low (y increases downward)
    const zErr = userWristZ - tmplWristZ  // positive = too far from body

    const handPosition = { xError: Math.round(xErr*100)/100, yError: Math.round(yErr*100)/100, zError: Math.round(zErr*100)/100 }

    // Describe position error in words
    const posIssues = []
    if (Math.abs(yErr) > 0.15) posIssues.push(yErr > 0 ? 'hand_too_low' : 'hand_too_high')
    if (Math.abs(xErr) > 0.15) posIssues.push(xErr > 0 ? 'hand_too_right' : 'hand_too_left')
    if (Math.abs(zErr) > 0.12) posIssues.push(zErr > 0 ? 'hand_too_far' : 'hand_too_close')

    // ── Per-finger extension analysis ──
    // Compare fingertip distance from wrist (user vs template)
    const fingerDetails = FINGER_GROUPS.map((fg, fi) => {
      const tipIdx = fg.indices[fg.indices.length - 1]  // fingertip landmark
      let userExt=0, tmplExt=0

      for (let f = midStart; f < midEnd; f++) {
        // Distance from wrist (landmark 0) to fingertip
        const ux = userFrames[f][tipIdx*3] - userFrames[f][0]
        const uy = userFrames[f][tipIdx*3+1] - userFrames[f][1]
        const uz = userFrames[f][tipIdx*3+2] - userFrames[f][2]
        userExt += Math.sqrt(ux*ux + uy*uy + uz*uz)

        const tx = tmpl.mean[f][tipIdx*3] - tmpl.mean[f][0]
        const ty = tmpl.mean[f][tipIdx*3+1] - tmpl.mean[f][1]
        const tz = tmpl.mean[f][tipIdx*3+2] - tmpl.mean[f][2]
        tmplExt += Math.sqrt(tx*tx + ty*ty + tz*tz)
      }
      userExt /= midCount
      tmplExt /= midCount

      const extDiff = userExt - tmplExt  // positive = user's finger more extended
      let issue = null
      if (Math.abs(extDiff) > 0.08) {
        issue = extDiff > 0 ? 'too_extended' : 'too_curled'
      }

      return {
        name: fg.name,
        nameVi: fg.nameVi,
        score: fingerScores[fi] ? fingerScores[fi].score : 0,
        extensionDiff: Math.round(extDiff * 100) / 100,
        issue,
      }
    })

    // ── Non-dominant hand check ──
    // See if template has non-zero data in the non-dominant slot (indices 63-125)
    let tmplNonDomEnergy = 0
    let userNonDomEnergy = 0
    for (let f = midStart; f < midEnd; f++) {
      for (let i = 63; i < 126; i++) {
        tmplNonDomEnergy += Math.abs(tmpl.mean[f][i])
        userNonDomEnergy += Math.abs(userFrames[f][i])
      }
    }
    tmplNonDomEnergy /= midCount
    userNonDomEnergy /= midCount

    const needsTwoHands = tmplNonDomEnergy > 5   // significant non-dominant hand movement in template
    const hasSecondHand = userNonDomEnergy > 2
    const twoHandIssue = needsTwoHands && !hasSecondHand ? 'missing_second_hand' : null

    // ── Motion analysis ──
    // Check if the user is moving enough (or too much) compared to template
    let userMotion=0, tmplMotion=0
    for (let f = midStart+1; f < midEnd; f++) {
      let uDelta=0, tDelta=0
      for (let i = 0; i < 63; i++) { // dominant hand only
        const ud = userFrames[f][i] - userFrames[f-1][i]
        const td = tmpl.mean[f][i] - tmpl.mean[f-1][i]
        uDelta += ud*ud
        tDelta += td*td
      }
      userMotion += Math.sqrt(uDelta)
      tmplMotion += Math.sqrt(tDelta)
    }
    userMotion /= (midCount-1||1)
    tmplMotion /= (midCount-1||1)

    let motionIssue = null
    if (tmplMotion > 0.5 && userMotion < tmplMotion * 0.4) motionIssue = 'too_still'
    else if (tmplMotion < 0.3 && userMotion > tmplMotion * 2.5 && userMotion > 0.5) motionIssue = 'too_much_motion'

    // ── Hand-face proximity ──
    // If template shows hand near face (pose landmarks near face landmarks), check user
    let tmplHandFaceDist = 99, userHandFaceDist = 99
    // Nose is at pose index 6 (POSE_IDX[6] = 0), offset 126+6*3 = 144
    const noseOffset = 126 + 6*3  // features 144,145,146
    for (let f = midStart; f < midEnd; f++) {
      // Distance from wrist to nose in template
      const tdx = tmpl.mean[f][0]-tmpl.mean[f][noseOffset]
      const tdy = tmpl.mean[f][1]-tmpl.mean[f][noseOffset+1]
      const td = Math.sqrt(tdx*tdx+tdy*tdy)
      if (td < tmplHandFaceDist) tmplHandFaceDist = td

      const udx = userFrames[f][0]-userFrames[f][noseOffset]
      const udy = userFrames[f][1]-userFrames[f][noseOffset+1]
      const ud = Math.sqrt(udx*udx+udy*udy)
      if (ud < userHandFaceDist) userHandFaceDist = ud
    }

    let faceProximityIssue = null
    const isFaceSign = tmplHandFaceDist < 1.5  // hand gets close to face in template
    if (isFaceSign && userHandFaceDist > tmplHandFaceDist * 2.0) {
      faceProximityIssue = 'hand_not_near_face'
    }

    return {
      handPosition,
      positionIssues: posIssues,
      fingers: fingerDetails,
      worstFingers: fingerDetails.filter(f => f.issue).sort((a,b) => Math.abs(b.extensionDiff) - Math.abs(a.extensionDiff)).slice(0,2),
      twoHanded: { needed: needsTwoHands, present: hasSecondHand, issue: twoHandIssue },
      motion: { userMotion: Math.round(userMotion*100)/100, templateMotion: Math.round(tmplMotion*100)/100, issue: motionIssue },
      faceProximity: { isFaceSign, issue: faceProximityIssue, userDist: Math.round(userHandFaceDist*100)/100, tmplDist: Math.round(tmplHandFaceDist*100)/100 },
      signKey: gloss,
      signEn: translateGloss(gloss),
      templateQuality: quality,  // lets the coach decide whether to suppress pose-related tips
    }
  }

  // ─── PROGRESS ────────────────────────────────────────────────────────

  _initProgress() {
    for (const k of Object.keys(this._signDB)) {
      if (!this._progress[k]) this._progress[k] = {stars:0, best:0, reps:0}
    }
  }

  _updateProgress(key, score) {
    const p = this._progress[key]
    if (!p) return
    const tmpl = this._templates[key]
    const quality = tmpl ? tmpl.quality : 'high'
    const newStars = _starsForScore(score, quality)
    if (score > p.best) p.best = score
    if (newStars > p.stars) {
      p.stars = newStars
      p.reps++
      this._emit('progress', {key, stars:p.stars, best:p.best, reps:p.reps, isNew:true})
      this._saveState()
    }
  }

  _saveState() {
    try {
      localStorage.setItem('sp3_progress', JSON.stringify(this._progress))
      localStorage.setItem('sp3_streak', this._streak)
      localStorage.setItem('sp3_streak_date', new Date().toDateString())
      localStorage.setItem('sp3_lessons', JSON.stringify([...this._lessonsCompleted]))
      localStorage.setItem('sp3_lang', this._lang)
    } catch(e) {}
  }

  _restoreState() {
    try {
      const p = localStorage.getItem('sp3_progress')
      if (p) {
        const d = JSON.parse(p)
        for (const k in d) { if (this._progress[k]) Object.assign(this._progress[k], d[k]) }
      }
      const savedStreak = Number(localStorage.getItem('sp3_streak'))
      this._streak = Number.isFinite(savedStreak) && savedStreak > 0 ? savedStreak : 1
      const ld = localStorage.getItem('sp3_streak_date')
      if (ld) { const diff = Math.floor((new Date() - new Date(ld))/864e5); if(diff>1) this._streak=1 }
      const lc = localStorage.getItem('sp3_lessons')
      if (lc) this._lessonsCompleted = new Set(JSON.parse(lc))
      const lang = localStorage.getItem('sp3_lang')
      if (lang === 'en' || lang === 'vi') { this._lang = lang; _lang = lang }
    } catch(e) {}
  }

  // ─── CURRICULUM ──────────────────────────────────────────────────────

  _buildCurriculum(glosses) {
    const buckets = {}
    CATEGORIES.forEach(c => { buckets[c.id] = {cat:c, signs:[]} })
    const other = []
    glosses.forEach(g => {
      let found = false
      for (const cat of CATEGORIES) {
        if (cat.matches && cat.matches.includes(g)) { buckets[cat.id].signs.push(g); found=true; break }
        if (cat.prefixes && cat.prefixes.some(p => g.startsWith(p))) { buckets[cat.id].signs.push(g); found=true; break }
      }
      if (!found) other.push(g)
    })
    this._lessons = []
    CATEGORIES.forEach(cat => {
      const b = buckets[cat.id]
      if (!b.signs.length) return
      this._lessons.push({
        id:cat.id, goal:cat.goal, icon:cat.icon, color:cat.color,
        signs: b.signs.map(g => ({key:g, vi:g, en:translateGloss(g)}))
      })
    })
    if (other.length) {
      this._lessons.push({
        id:'other', goal:{vi:'Từ khác',en:'Other Words'}, icon:'📝', color:'#888',
        signs: other.map(g => ({key:g, vi:g, en:translateGloss(g)}))
      })
    }
    this._signDB = {}
    this._lessons.forEach(lesson => {
      lesson.signs.forEach(sign => {
        this._signDB[sign.key] = {...sign, unitId:lesson.id, unitGoal:lesson.goal, unitIcon:lesson.icon}
      })
    })
    console.log(`[engine] Curriculum: ${this._lessons.length} lessons, ${Object.keys(this._signDB).length} signs`)
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────

  selectSign(key) {
    if (!this._signDB[key]) { console.warn(`[engine] Unknown sign: ${key}`); return }
    this._activeSign = key
    this._frameBuffer = []
    this._scoreBuffer = []
    this._smoothedScore = null
    this._lastCompareTime = 0
  }

  clearSign() {
    this._activeSign = null
    this._frameBuffer = []
    this._scoreBuffer = []
    this._smoothedScore = null
  }

  setLang(lang) {
    if (lang !== 'vi' && lang !== 'en') return
    this._lang = lang; _lang = lang
    this._saveState()
  }

  getLessons()        { return this._lessons }
  getSign(key)        { return this._signDB[key] || null }
  getProgress()       { return {progress:this._progress, streak:this._streak, lessonsCompleted:this._lessonsCompleted} }
  getSignProgress(key){ return this._progress[key] || {stars:0, best:0, reps:0} }
  getLang()           { return this._lang }
  getActiveSign()     { return this._activeSign }
  isReady()           { return this._templatesReady && this._running }
  getVersion()        { return VERSION }

  getFPS() {
    // Returns effective inference FPS based on last ~30 MediaPipe send() round-trips.
    // Returns null until enough samples collected. Useful for detecting when device
    // can't keep up — scoring quality degrades when this drops below ~15fps.
    if (!this._frameTimings || this._frameTimings.length < 5) return null
    const avg = this._frameTimings.reduce((a,b)=>a+b,0) / this._frameTimings.length
    return Math.round(1000 / avg)
  }

  getTemplate(key) {
    // Expose template data for visualization (e.g., reference animation)
    return this._templates[key] || null
  }

  getTemplateQuality(key) {
    // Returns 'high' | 'low' | null (null for unknown signs). Cheap sync
    // read; the UI can use this to show a "single-signer reference" badge.
    const t = this._templates[key]
    return t ? t.quality : null
  }

  completeLesson(lessonId) {
    this._lessonsCompleted.add(lessonId)
    const lesson = this._lessons.find(l => l.id === lessonId)
    if (lesson) {
      lesson.signs.forEach(s => {
        const p = this._progress[s.key]
        if (p && p.stars < 1) { p.stars = 1; p.reps++ }
      })
    }
    this._saveState()
  }

  getStats() {
    const totalStars = Object.values(this._progress).reduce((a,x) => a+x.stars, 0)
    const mastered = Object.values(this._progress).filter(x => x.stars >= 3).length
    return {totalStars, mastered, streak:this._streak, lessonsCompleted:this._lessonsCompleted.size, totalSigns:Object.keys(this._signDB).length}
  }

  // Inference loop runner. Extracted from init() so pauseCapture / resume-
  // Capture can halt + restart it without duplicating the body. init() still
  // owns running-state reset (this._running = true, counters=0, etc.); this
  // method just starts the rAF loop and stamps `this._loopId`.
  _startInferenceLoop() {
    const MIN_SEND_INTERVAL_MS = 33  // ~30fps cap — MediaPipe can't keep up past this at complexity 1
    const self = this
    const loop = () => {
      if (!self._running) return
      const nowMs = performance.now()
      if (!document.hidden && self._video && self._video.readyState >= 2
          && !self._inferenceRunning && nowMs - self._lastSentTime > MIN_SEND_INTERVAL_MS) {
        self._inferenceRunning = true
        self._lastSentTime = nowMs
        self._holistic.send({image: self._video})
          .then(() => {
            self._inferenceRunning = false
            self._consecutiveErrors = 0
            const dt = performance.now() - nowMs
            self._frameTimings.push(dt)
            if (self._frameTimings.length > 30) self._frameTimings.shift()
          })
          .catch(() => {
            self._inferenceRunning = false
            self._consecutiveErrors++
            if (self._consecutiveErrors >= 15) {
              self._emit('error', {message: 'Tracking errors — try reloading', type: 'tracking'})
              self._consecutiveErrors = 0
            }
          })
      }
      self._loopId = requestAnimationFrame(loop)
    }
    loop()
  }

  // Pause the capture pipeline without tearing down MediaPipe.
  //   - halts the rAF inference loop (no more onResults callbacks)
  //   - stops every MediaStream track so the webcam LED goes dark
  //   - leaves `this._holistic` loaded so resumeCapture restarts fast
  // Call from whichever screen owns the live camera (practice.js) on
  // unmount. Safe to call repeatedly — subsequent calls are no-ops once
  // the stream is already released.
  async pauseCapture() {
    if (!this._running && !(this._video && this._video.srcObject)) return
    this._running = false
    if (this._loopId) { cancelAnimationFrame(this._loopId); this._loopId = null }

    // Wait for any in-flight MediaPipe inference to settle so its
    // onResults doesn't fire against torn-down handlers.
    const waitStart = Date.now()
    while (this._inferenceRunning && Date.now() - waitStart < 500) {
      await new Promise(r => setTimeout(r, 20))
    }

    if (this._video && this._video.srcObject) {
      this._video.srcObject.getTracks().forEach(t => {
        try { t.stop() } catch (e) { console.error('[engine] track.stop failed:', e) }
      })
      this._video.srcObject = null
    }
    this._frameBuffer = []
    this._scoreBuffer = []
    this._lastFrame = null
    this._originHistory = []
  }

  // Re-acquire the camera and restart the inference loop. Assumes
  // init() has already run once (templates loaded, holistic constructed).
  // If called before init or after destroy, we surface an engine error
  // rather than pretending to succeed.
  async resumeCapture() {
    if (this._running) return  // already live
    if (!this._video) {
      this._emit('error', { message: 'resumeCapture: no video element bound', type: 'camera' })
      return
    }
    if (!this._holistic) {
      this._emit('error', { message: 'resumeCapture: Holistic not initialized', type: 'mediapipe' })
      return
    }
    try {
      if (!this._video.srcObject) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
        })
        this._video.srcObject = stream
      }
      await this._video.play()
    } catch (e) {
      if (this._video.srcObject) {
        this._video.srcObject.getTracks().forEach(t => { try { t.stop() } catch(_){} })
        this._video.srcObject = null
      }
      this._emit('error', { message: `Camera re-acquire failed: ${e.message}`, type: 'camera' })
      return
    }
    this._running = true
    this._inferenceRunning = false
    this._consecutiveErrors = 0
    this._lastSentTime = 0
    this._startInferenceLoop()
  }

  async destroy() {
    this._running = false
    if (this._loopId) { cancelAnimationFrame(this._loopId); this._loopId = null }

    // Wait for any in-flight inference to settle before tearing down holistic.
    // Otherwise its onResults callback can fire against a half-destroyed engine.
    const waitStart = Date.now()
    while (this._inferenceRunning && Date.now() - waitStart < 500) {
      await new Promise(r => setTimeout(r, 20))
    }

    if (this._holistic) {
      try { if (typeof this._holistic.close === 'function') await this._holistic.close() } catch(e) {}
      this._holistic = null
    }
    if (this._video && this._video.srcObject) {
      this._video.srcObject.getTracks().forEach(t => t.stop())
      this._video.srcObject = null
    }
    this._listeners = {}
    this._frameBuffer = []
    this._scoreBuffer = []
  }

  _waitForGlobal(name, timeout=12000) {
    return new Promise((resolve, reject) => {
      if (typeof window[name] !== 'undefined') return resolve()
      const start = Date.now()
      const check = () => {
        if (typeof window[name] !== 'undefined') return resolve()
        if (Date.now() - start > timeout) return reject(new Error(`${name} failed to load`))
        setTimeout(check, 150)
      }
      check()
    })
  }
}

global.SignPathEngine = SignPathEngine
// Internals for Node-side unit tests. Not part of the public UI contract —
// if the UI reaches for anything under _internals, it's a smell.
global.SignPathEngine._internals = {
  NUM_FEATURES,
  SIM_THRESHOLDS,
  STAR_THRESHOLDS_HIGH,
  STAR_THRESHOLDS_LOW,
  WEIGHTS_HIGH, WEIGHTS_LOW,
  WEIGHTS_SQ_HIGH, WEIGHTS_SQ_LOW,
  NONDOM_MOTION_RATIO_THRESHOLD,        // [Fix 1 v2] exposed for M-series tests
  FINGER_SIM_FLOOR,                     // [Leniency] Fix 1 — finger curve bounds
  FINGER_SIM_CEILING,
  SHOULDER_VIS_STRICT,                  // [Leniency] Fix 3 — both-shoulders threshold
  SHOULDER_VIS_LOOSE,                   // [Leniency] Fix 3 — single-shoulder threshold
  _simToScore,
  _fingerSimToScore,                    // [Leniency] Fix 1 — dedicated finger curve
  _starsForScore,
  _normalizeQuality,
  _frameNorm,
  _frameWeightedNorm,
  _cosineSimilarityWeightedPrenormed,
  _cosineSimilarityWeightedMasked,      // [Fix 1] exposed for skip-non-dom tests
  _compareSequencesWeightedBand,        // [Fix 3] exposed for per-band debug tests
  _pickOrigin,                           // [Fix 3] exposed for refType tests
  _computeNonDomMotionRatio,            // [Fix 1 v2] exposed for M-series tests
}

})(typeof window !== 'undefined' ? window : this);
