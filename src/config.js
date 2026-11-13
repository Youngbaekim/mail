// YB-Mail 설정값
// CLIENT_ID: Google Cloud 콘솔 → Google 인증 플랫폼 → 클라이언트에서 만든 "웹 애플리케이션" OAuth 클라이언트 ID
//  - 비밀번호가 아닌 공개 식별값이므로 공개 저장소에 넣어도 됩니다(승인된 주소에서만 동작).
//  - 비워 두면 앱 첫 화면에서 직접 붙여넣을 수 있습니다(그 기기에만 저장).
export const CLIENT_ID = '464114113553-h7i144oehp2besm28qk56cvjjsk8lt0r.apps.googleusercontent.com';

// 읽기·보관·라벨 변경·보내기·임시 저장 권한 (영구 삭제는 불가 → 삭제는 휴지통 이동)
// + 필터 설정 권한(보낸 사람 차단)
export const SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic';

// 계정 표시 색 (추가 순서대로)
export const ACCOUNT_COLORS = ['#2f6fd6', '#d9822b', '#2a9d6a', '#a24fc4'];
