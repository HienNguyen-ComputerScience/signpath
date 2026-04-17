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
const CONFIG_PATH = 'models/model-config.json'

// Preprocessing (must match build_templates.py exactly)
const NUM_FEATURES = 162
const POSE_IDX = [11, 12, 13, 14, 15, 16, 0]
const FACE_IDX = [1, 10, 152, 234, 454]
const SHOULDER_VIS = 0.5
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

const SIM_THRESHOLDS = {
  high: { floor: 0.55, ceiling: 0.95, passAt: 70 },
  low:  { floor: 0.40, ceiling: 0.85, passAt: 55 },
}

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
// Hand band gets 1.5, pose+face band gets 0.3 for low-tier templates. High
// tier keeps all-1 weights (weighted cosine reduces to plain cosine). These
// numbers are a v1 guess. TODO(v1.5): POSE_IDX contains wrist landmarks
// (15, 16) which are anatomically hand-adjacent but live in the pose band
// at 0.3 — revisit once we have real low-tier data to eval against.

const WEIGHTS_HIGH = new Float32Array(NUM_FEATURES).fill(1.0)

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
    const ls=pose[11], rs=pose[12]
    const lv=ls.visibility!=null?ls.visibility:1, rv=rs.visibility!=null?rs.visibility:1
    if (lv>SHOULDER_VIS && rv>SHOULDER_VIS) {
      const ox=(ls.x+rs.x)/2, oy=(ls.y+rs.y)/2, oz=((ls.z||0)+(rs.z||0))/2
      const s=Math.sqrt((ls.x-rs.x)**2+(ls.y-rs.y)**2+((ls.z||0)-(rs.z||0))**2)
      if (s>MIN_SHOULDER_W) return {ox,oy,oz,scale:s}
    }
  }
  const h=rHand||lHand
  if (h&&h.length>=10) {
    const w=h[0],m=h[9]
    const s=Math.sqrt((m.x-w.x)**2+(m.y-w.y)**2+((m.z||0)-(w.z||0))**2)
    if (s>MIN_PALM) return {ox:w.x,oy:w.y,oz:w.z||0,scale:s}
  }
  return null
}

function _buildFrame(rHand, lHand, pose, face) {
  const f=new Float32Array(NUM_FEATURES)
  const o=_pickOrigin(pose,rHand,lHand)
  if (!o) return f
  const {ox,oy,oz,scale}=o
  const n=lm=>lm?[((lm.x||0)-ox)/scale,((lm.y||0)-oy)/scale,((lm.z||0)-oz)/scale]:null

  let dom=rHand, nonDom=lHand
  if (!dom&&nonDom){dom=nonDom;nonDom=null}

  if (dom&&dom.length>=21) for(let i=0;i<21;i++){const v=n(dom[i]);if(v){f[i*3]=v[0];f[i*3+1]=v[1];f[i*3+2]=v[2]}}
  if (nonDom&&nonDom.length>=21) for(let i=0;i<21;i++){const v=n(nonDom[i]);if(v){f[63+i*3]=v[0];f[63+i*3+1]=v[1];f[63+i*3+2]=v[2]}}
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
    const configPath = opts.configPath || CONFIG_PATH

    // 1. Load templates
    try {
      const res = await fetch(templatesPath)
      if (!res.ok) throw new Error(`${templatesPath} returned ${res.status}`)
      const data = await res.json()
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
        }
      }
      this._templatesReady = true
      console.log(`[engine] Loaded ${Object.keys(this._templates).length} templates (${this._templateFrameCount} frames each)`)
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
    const MIN_SEND_INTERVAL_MS = 33  // cap at ~30fps — MediaPipe can't keep up above this anyway at complexity 1
    const loop = () => {
      if (!this._running) return
      const nowMs = performance.now()
      if (!document.hidden && this._video.readyState >= 2 && !this._inferenceRunning && nowMs - this._lastSentTime > MIN_SEND_INTERVAL_MS) {
        this._inferenceRunning = true
        this._lastSentTime = nowMs
        this._holistic.send({image: this._video})
          .then(() => {
            this._inferenceRunning = false
            this._consecutiveErrors = 0
            const dt = performance.now() - nowMs
            this._frameTimings.push(dt)
            if (this._frameTimings.length > 30) this._frameTimings.shift()
          })
          .catch(() => {
            this._inferenceRunning = false
            this._consecutiveErrors++
            if (this._consecutiveErrors >= 15) {
              this._emit('error', {message: 'Tracking errors — try reloading', type: 'tracking'})
              this._consecutiveErrors = 0
            }
          })
      }
      this._loopId = requestAnimationFrame(loop)
    }
    loop()

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

    // Build normalized feature vector for this frame
    const frame = _buildFrame(rHand, lHand, pose, face)

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
    const rawScore = selectedEntry ? selectedEntry.score : 0
    const selectedQuality = selectedEntry
      ? selectedEntry.quality
      : (this._templates[key] ? this._templates[key].quality : 'high')
    const passAt = SIM_THRESHOLDS[selectedQuality].passAt
    const rawPassed = rawScore >= passAt

    const selectedRank = scores.findIndex(s => s.gloss === key)
    const top1Sim = top5[0] ? top5[0].similarity : 0

    // [M-5]+quality: isMatch now prioritises pass-status. Passing the
    // selected sign's threshold is a stronger signal than out-ranking it
    // on a sub-threshold attempt.
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

    // Per-finger scores + deviations are quality-aware (score mapping only;
    // finger cosine itself is unweighted because fingers live in one band).
    const fingerScores = this._computeFingerScores(userFrames, key, selectedQuality)
    const deviations = this._computeDeviations(userFrames, key, fingerScores, selectedQuality)

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

    this._updateProgress(key, score)
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
        score: _simToScore(sim, quality),
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
  _simToScore,
  _starsForScore,
  _normalizeQuality,
  _frameNorm,
  _frameWeightedNorm,
  _cosineSimilarityWeightedPrenormed,
}

})(typeof window !== 'undefined' ? window : this);
