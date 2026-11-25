// ─────────────────────────────────────────────────────────────
// 설정 파일: 이 파일만 고치면 됩니다.
//
// firebase: Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)에서 보이는
//   firebaseConfig 값을 그대로 붙여 넣으세요.
//   비워 두면(null) 이 기기 안에서만 동작하는 "미리보기 모드"로 열립니다.
//   (이 값들은 공개돼도 괜찮은 값입니다. 누가 읽고 쓸 수 있는지는
//    Firebase 콘솔에 넣는 보안 규칙(firestore.rules)이 정합니다.)
//
// 두 사람의 이메일은 이 파일에 적지 않습니다. 공개 사이트에 노출되지 않도록
// Firebase 콘솔의 보안 규칙에만 넣습니다.
// ─────────────────────────────────────────────────────────────

export const CONFIG = {
  firebase:{ 
  apiKey: "AIzaSyAwgOXLgh4tRuKSXUec8ifxf2_g246nHB8",
  authDomain: "our-bible-9ab06.firebaseapp.com",
  projectId: "our-bible-9ab06",
  storageBucket: "our-bible-9ab06.firebasestorage.app",
  messagingSenderId: "1024858272941",
  appId: "1:1024858272941:web:1c638989f02efb8ba1c224"
   },

  // 미리보기 모드에서만 쓰는 이름
  demoNames: ["강민", "나희"]
};
