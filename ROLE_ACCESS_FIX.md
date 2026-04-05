# Role-Based Access Control Fix

## 🎯 Problem
Users with `familyRole: "parent"` in the `Registerd` collection were not getting proper access to features because:
1. The `RoleAccessService` was only checking the `List Of Families` collection for roles
2. The `scheduling` page was directly checking `getFamilyMembers()` instead of using `RoleAccessService`

## ✅ Solution
**Updated 2 files:**

### 1. `src/app/services/role-access.service.ts`
Updated `getUserRole()` to:
1. **First check** the `Registerd` collection via `getUserFamilyInfo()` for the `familyRole` field
2. **Fallback** to checking the `List Of Families` collection if not found
3. Handle both "parent" and "parents" (case-insensitive)

### 2. `src/app/scheduling/scheduling.page.ts`
Updated `loadUserRole()` to:
1. **Use `RoleAccessService`** instead of directly checking `getFamilyMembers()`
2. Use `userRole.canAccessScheduling` permission flag
3. Added console logs for debugging
4. Fallback to old method if `RoleAccessService` fails

## 🔑 Role Permissions

### **Owner** (Family Creator)
- ✅ Analytics
- ✅ Consent Letter Creation
- ✅ Scheduling
- ✅ QR Code Display
- ✅ View Schedules
- ✅ Show Consent Letters
- ✅ Notifications
- ✅ Manage Family
- ✅ Remove Members
- ✅ Change Roles

### **Parent** (Same as Owner)
- ✅ Analytics
- ✅ Consent Letter Creation
- ✅ Scheduling
- ✅ QR Code Display
- ✅ View Schedules
- ✅ Show Consent Letters
- ✅ Notifications
- ✅ Manage Family
- ✅ Remove Members
- ✅ Change Roles

### **Companion** (Limited Access)
- ✅ QR Code Display
- ✅ View Schedules
- ✅ Show Consent Letters
- ✅ Notifications
- ❌ Analytics
- ❌ Consent Letter Creation
- ❌ Scheduling
- ❌ Manage Family
- ❌ Remove Members
- ❌ Change Roles

## 📝 Code Changes

### File 1: `src/app/services/role-access.service.ts`

**Before:**
```typescript
if (isOriginalCreator) {
  userRole = 'owner';
} else {
  const members = await this.familyService.getFamilyMembers(family.name);
  const userMember = members.find(member => member.uid === currentUser.uid);
  if (userMember) {
    userRole = userMember.role;
  }
}
```

**After:**
```typescript
if (isOriginalCreator) {
  userRole = 'owner';
} else {
  // First, check the user's familyRole from getUserFamilyInfo (which checks Registerd collection)
  const userFamilyInfo = await this.familyService.getUserFamilyInfo();
  if (userFamilyInfo && userFamilyInfo.familyRole) {
    const role = userFamilyInfo.familyRole.toLowerCase();
    if (role === 'parent' || role === 'parents') {
      userRole = 'parent';
    } else if (role === 'companion') {
      userRole = 'companion';
    } else if (role === 'owner') {
      userRole = 'owner';
    }
    console.log('✅ Role detected from Registerd collection:', userRole);
  } else {
    // Fallback: check List Of Families collection
    const members = await this.familyService.getFamilyMembers(family.name);
    const userMember = members.find(member => member.uid === currentUser.uid);
    if (userMember) {
      userRole = userMember.role;
      console.log('✅ Role detected from List Of Families:', userRole);
    }
  }
}
```

### File 2: `src/app/scheduling/scheduling.page.ts`

**Before:**
```typescript
async loadUserRole() {
  try {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    const family = await this.familyService.getUserFamily();
    if (!family) return;

    const members = await this.familyService.getFamilyMembers(family.name);
    const userMember = members.find(member => member.uid === currentUser.uid);

    if (userMember) {
      this.currentUserRole = userMember.role;
      this.canManageSchedule = userMember.role === 'owner' || userMember.role === 'parent';
    }
  } catch (error) {
    console.error('Error loading user role:', error);
  }
}
```

**After:**
```typescript
async loadUserRole() {
  try {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    const family = await this.familyService.getUserFamily();
    if (!family) return;

    // Use RoleAccessService to get the correct role (checks Registerd collection first)
    const userRole = await this.roleAccessService.getUserRole();

    if (userRole) {
      this.currentUserRole = userRole.role;
      this.canManageSchedule = userRole.canAccessScheduling;
      console.log('✅ Scheduling page - User role:', this.currentUserRole, 'Can manage schedule:', this.canManageSchedule);
    } else {
      // Fallback to checking family members
      const members = await this.familyService.getFamilyMembers(family.name);
      const userMember = members.find(member => member.uid === currentUser.uid);

      if (userMember) {
        this.currentUserRole = userMember.role;
        this.canManageSchedule = userMember.role === 'owner' || userMember.role === 'parent';
        console.log('⚠️ Scheduling page - Fallback role from members:', this.currentUserRole);
      }
    }
  } catch (error) {
    console.error('Error loading user role:', error);
  }
}
```

## 🧪 Testing

To verify the fix works:

1. **Login** with a user that has `familyRole: "parent"` in the `Registerd` collection
2. **Check the console** - you should see:
   ```
   ✅ Role detected from Registerd collection: parent
   🎭 Final user role: parent for family: [Family Name]
   User role loaded: { role: 'parent', familyName: '...', canAccessAnalytics: true, ... }
   ```
3. **Try accessing features:**
   - Analytics ✅
   - Set Schedule ✅
   - Digital Consent ✅
   - Display QR ✅
   - View Schedule ✅
   - Consent Letter ✅

All features should now be accessible for users with `familyRole: "parent"`!

## 📊 Database Structure

### Registerd Collection
```json
{
  "uid": "YJR99XVGRe4ekMen1dMZDHnT",
  "email": "Queenie.Bautista@gmail.com",
  "fullName": "Queenie S. Bautista",
  "familyName": "Students",
  "familyRole": "parent",  // ← This field is now properly detected!
  "password": "IspQZY4I8Af",
  "profilePicture": "https://..."
}
```

### List Of Families Collection
```json
{
  "Family Name": "Students",
  "Parent Full Name": "Queenie S. Bautista",
  "uid": "YJR99XVGRe4ekMen1dMZDHnT",
  "Role": "owner"  // ← Fallback if familyRole not in Registerd
}
```

## 🎉 Result

Users with `familyRole: "parent"` in the `Registerd` collection now have **full access to all features**, just like family owners!

