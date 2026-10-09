// 複製這個檔案為 firebase-config.js，填入你自己 Firebase 專案的值。
// 這些值不是密鑰，寫進前端程式碼是 Firebase 官方預期的用法；
// 真正的存取控制交給 firestore.rules，不是靠隱藏這個設定檔。
// 在 Firebase Console → 專案設定 → 一般 → 「你的應用程式」→ SDK 設定與程式碼 可以直接複製出這個物件。
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};
