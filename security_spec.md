# Firebase Security Specification

## Data Invariants
- Admin data (notices, rules, departments, faculty, categories, portalLinks) is publicly readable but only writable by admins.
- Support tickets can be created by anyone (authenticated or anonymous, though usually we prefer authenticated for tracking).
- Support tickets can be read by the creator (matched by email/phone or UID if available) and admins.
- Only admins can update the `adminResponse` and `status` of a support ticket.
- Admins are identified by a specific `admins` collection where document ID is the UID.

## The "Dirty Dozen" Payloads (Red Team Test Cases)
1. **Unauthorized Rule Write**: Attempt to create a rule without being an admin.
2. **Rule Delete**: Attempt to delete a rule as a regular user.
3. **Notice Modification**: Attempt to change the title of a notice as a regular user.
4. **Shadow Ticket Update**: Attempt to update another user's support ticket status to 'Resolved'.
5. **Ghost Field Injection**: Attempt to inject an `isAdmin` field into a support ticket.
6. **Ticket Hijack**: Attempt to read all support tickets as a non-admin.
7. **Invalid Type Write**: Attempt to write a number into the `title` field of a notice.
8. **Massive ID Poisoning**: Attempt to use a 1MB string as a document ID for a rule.
9. **Creation Spoofing**: Attempt to set the `timestamp` of a ticket to a future date.
10. **Admin Self-Promotion**: Attempt to create a document in the `admins` collection as a regular user.
11. **PII Leak**: Attempt to list all support tickets (which contains emails/phones) as an unauthorized user.
12. **Status Skipping**: Attempt to create a ticket that is already marked as 'Resolved'.

## Helper Primitives
```javascript
function isSignedIn() { return request.auth != null; }
function isAdmin() { return isSignedIn() && exists(/databases/$(database)/documents/admins/$(request.auth.uid)); }
function isOwner(email) { return isSignedIn() && request.auth.token.email == email; }
```
