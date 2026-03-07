/**
 * Firebase Configuration
 *
 * SETUP INSTRUCTIONS (one-time, app developer only — users never see this):
 *
 * 1. Go to https://console.firebase.google.com/ and create a new project.
 * 2. In Project Settings → General, scroll to "Your apps" and click "Web" (</>).
 *    Register the app and copy the firebaseConfig object below.
 * 3. In Authentication → Sign-in method, enable "Google".
 * 4. In Storage → Get started, create a default bucket.
 * 5. Set Storage Rules to allow authenticated users to read/write their own data:
 *
 *      rules_version = '2';
 *      service firebase.storage {
 *        match /b/{bucket}/o {
 *          match /users/{userId}/{allPaths=**} {
 *            allow read, write: if request.auth != null && request.auth.uid == userId;
 *          }
 *        }
 *      }
 *
 * 6. Configure CORS for the storage bucket (required for browser uploads).
 *    Create a file cors.json with this content:
 *      [{ "origin": ["*"], "method": ["GET","PUT","POST","DELETE"], "maxAgeSeconds": 3600 }]
 *    Then run:
 *      gsutil cors set cors.json gs://YOUR_PROJECT_ID.firebasestorage.app
 *
 * 7. Replace the placeholder values below with your project's config.
 */
// eslint-disable-next-line no-unused-vars
const FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};
