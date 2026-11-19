# RODALOKA Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **User PII Isolation**: `/users/{userId}` is strictly readable and writable only by the authenticated owner (`request.auth.uid == userId`).
2. **Vendor Ownership & Financial Split**: `/vendors/{vendorId}` public storefront is readable by users; mutations require `owner_uid == request.auth.uid`. Sensitive banking/private courier details live under `/vendors/{vendorId}/private/finance`, readable and writable strictly by the vendor owner.
3. **Product Referential Integrity & Stock Protection**: `/products/{productId}` creation verifies parent vendor exists and belongs to `request.auth.uid`. Buyers cannot tamper with product prices or names; stock updates by buyers are constrained strictly to decrementing `stock` and incrementing `sold_count` by the exact delta.
4. **Order Access & Terminal State Lock**: `/orders/{orderId}` can only be read/listed by `buyer_uid == request.auth.uid` or `vendor_owner_uid == request.auth.uid`. Once `order_status` is `completed` or `rejected`, no further mutations are permitted.
5. **Order Items Master Gate**: `/orders/{orderId}/items/{itemId}` checks parent order ownership via `get()`.
6. **Favorites & Notifications Ownership**: `/favorites/{favId}` is strictly owner-scoped; `/notifications/{notifId}` can only be read/listed by `recipient_uid == request.auth.uid` and only `is_read` may be updated by the recipient.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Cross-User PII Read**: Non-owner attempting `get /users/other_uid`.
2. **Shadow Field Injection on User**: Creating `/users/{uid}` with undocumented field `isAdmin: true`.
3. **Bank Account Theft**: Non-owner attempting `get /vendors/VND-001/private/finance`.
4. **Vendor Ownership Spoofing**: Creating `/vendors/VND-FAKE` with `owner_uid: "victim_uid"`.
5. **Price Tampering by Buyer**: Non-owner attempting to update `/products/PRD-1001` `price` to `1`.
6. **Orphan Product Creation**: Creating `/products/PRD-ORPHAN` referencing non-existent `vendor_id: "VND-NONE"`.
7. **Order Status Shortcut**: Creating `/orders/ORD-1` directly with `order_status: "completed"`.
8. **Terminal State Resurrection**: Updating an order whose existing `order_status == "completed"` back to `"preparing"`.
9. **Unauthorized Order Scraping**: Listing `/orders` without filtering to `buyer_uid` or `vendor_owner_uid`.
10. **ID Poisoning Attack**: Creating `/vendors/<200-char-invalid-id>` failing `isValidId()`.
11. **Timestamp Forgery**: Creating an order with client-spoofed `created_at` != `request.time`.
12. **Notification Tampering**: Recipient modifying `body` or `category` of `/notifications/{id}` instead of only `is_read`.
