# Firestore Security Rules Guide

## 📋 Overview

This document explains the Firestore security rules for the FetchSafe application and how to deploy them.

## 🚀 How to Deploy the Rules

### Option 1: Copy and Paste in Firebase Console (Recommended)

1. **Open Firebase Console:**
   - Go to: https://console.firebase.google.com/u/0/project/fetchsafe2/firestore/databases/-default-/rules

2. **Copy the Rules:**
   - Open the `firestore.rules` file in this project
   - Copy all the content

3. **Paste in Console:**
   - Paste the rules into the Firebase Console editor
   - Click **"Publish"**
   - Wait a few seconds for the rules to propagate

### Option 2: Deploy via Firebase CLI

```bash
# Install Firebase CLI (if not already installed)
npm install -g firebase-tools

# Login to Firebase
firebase login

# Initialize Firebase in your project (if not already done)
firebase init firestore

# Deploy the rules
firebase deploy --only firestore:rules
```

## 📚 Collections and Their Rules

### 1. **Registerd** Collection
- **Purpose:** Stores user registration data
- **Document ID:** User's UID (matches Firebase Auth UID)
- **Rules:**
  - ✅ Users can create their own document during registration
  - ✅ Users can read and update their own document
  - ✅ All authenticated users can read other users' basic info (for family features)
  - ❌ Deletion is disabled for data safety

### 2. **List Of Families** Collection
- **Purpose:** Stores family information and members
- **Rules:**
  - ✅ All authenticated users can read (for browsing families)
  - ✅ Authenticated users can create family documents
  - ✅ Family members can update their family documents
  - ✅ Family owners can delete their family documents

### 3. **Join Requests** Collection
- **Purpose:** Manages family join requests
- **Rules:**
  - ✅ Authenticated users can create join requests
  - ✅ Requester and family owner can read requests
  - ✅ Family owner can update (approve/deny) requests
  - ✅ Requester or family owner can delete requests

### 4. **Schedules** Collection
- **Purpose:** Stores pickup schedules
- **Rules:**
  - ✅ All authenticated users can read schedules
  - ✅ Authenticated users can create schedules
  - ✅ Creator or assigned fetcher can update schedules
  - ✅ Creator can delete schedules

### 5. **Consent Letters** Collection
- **Purpose:** Stores consent letters for child pickups
- **Rules:**
  - ✅ All authenticated users can read consent letters
  - ✅ Authenticated users can create consent letters
  - ✅ Owner can update/delete their consent letters

### 6. **Notifications** Collection
- **Purpose:** Stores user notifications
- **Rules:**
  - ✅ Recipients can read their notifications
  - ✅ Authenticated users can create notifications
  - ✅ Recipients can update (mark as read) their notifications
  - ✅ Recipient or sender can delete notifications

### 7. **Panic Alert** Collection
- **Purpose:** Stores emergency panic alerts
- **Rules:**
  - ✅ All authenticated users can read panic alerts
  - ✅ Authenticated users can create panic alerts
  - ✅ Alert creator can update their alerts
  - ❌ Deletion is disabled for safety/audit purposes

### 8. **Pending Child Approvals** Collection
- **Purpose:** Manages child approval requests
- **Rules:**
  - ✅ All authenticated users can read pending approvals
  - ✅ Authenticated users can create approval requests
  - ✅ Authenticated users can update approval status
  - ✅ Submitter can delete their pending requests

### 9. **users** Collection
- **Purpose:** Stores user-specific data (push tokens, etc.)
- **Rules:**
  - ✅ Users can read and write their own user document
  - ✅ Authenticated users can create user documents

### 10. Other Collections
- **notifications** (lowercase)
- **Admin Notifications**
- **StudentData**
- **UserEmails**

All have basic authenticated user access.

## 🔒 Security Features

### Authentication Required
All operations require the user to be authenticated via Firebase Authentication.

### Owner-Based Access
Many collections use owner-based access control:
- Users can only modify their own documents
- Document ID or `uid` field is used to verify ownership

### Family-Based Access
Some collections allow access based on family membership:
- Family members can access family-related data
- Family owners have additional permissions

### Audit Trail
Certain collections (like Panic Alert) prevent deletion to maintain an audit trail.

## ⚠️ Important Notes

### Registration Flow
The registration process works as follows:
1. User creates Firebase Auth account (gets UID)
2. User document is created in `Registerd` collection with UID as document ID
3. User is signed out
4. User can then log in with their credentials

### Document ID = UID
The `Registerd` collection uses the Firebase Auth UID as the document ID. This ensures:
- Easy lookup of user data
- Consistent authentication between Firebase Auth and Firestore
- Better security (document ID matches authenticated user)

## 🧪 Testing the Rules

After deploying, test the following:

1. **Registration:** Create a new user account
2. **Login:** Log in with the new account
3. **Create Family:** Create a new family
4. **Join Family:** Have another user join the family
5. **Create Schedule:** Create a pickup schedule
6. **Panic Alert:** Trigger a panic alert
7. **Notifications:** Check if notifications are created and readable

## 🔧 Troubleshooting

### "Missing or insufficient permissions" Error

If you see this error:
1. Make sure the user is authenticated
2. Check that the document ID matches the user's UID (for Registerd collection)
3. Verify the rules have been published in Firebase Console
4. Wait a few seconds for rules to propagate

### Rules Not Working

1. Check the Firebase Console for rule errors
2. Use the Firebase Rules Playground to test specific operations
3. Check the browser console for detailed error messages

## 📝 Customization

To make the rules more restrictive:
1. Remove the broad `allow read: if isAuthenticated()` rules
2. Add specific family membership checks
3. Implement role-based access control

To make the rules more permissive (for development only):
1. Uncomment the default rule at the bottom
2. Change it to `allow read, write: if true;`
3. **⚠️ WARNING:** Never use permissive rules in production!

## 🎯 Next Steps

After deploying these rules:
1. Test all app functionality
2. Monitor Firebase Console for any permission errors
3. Adjust rules as needed based on your specific requirements
4. Consider implementing more granular role-based access control

