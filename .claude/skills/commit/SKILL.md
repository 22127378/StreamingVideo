---
name: commit
description: Tạo git commit cho StreamForge theo quy ước của dự án ([NAMESPACE] mô tả). Dùng khi người dùng yêu cầu commit, chia commit, viết commit message hoặc hỏi quy tắc commit.
---

# Commit theo quy ước StreamForge

Chỉ commit khi người dùng yêu cầu rõ ràng. Nếu họ nói "chưa commit", chỉ sửa code và để thay đổi ở working tree.

## Định dạng

```
[NAMESPACE] Short, clear description of the change
```

- Dòng đầu tối đa 72 ký tự, viết tiếng Anh, động từ ở thể mệnh lệnh (Add, Fix, Remove...), không có dấu chấm cuối.
- Sau dòng đầu có thể để một dòng trống rồi viết phần thân giải thích lý do, nếu thay đổi cần giải thích.
- Các trailer như `Co-Authored-By:` nằm ở cuối phần thân.

| Namespace | Dùng khi |
| --- | --- |
| ADD | Thêm tính năng, file hoặc chức năng mới |
| FEATURE | Cải tiến một tính năng đã có |
| DELETE | Xoá tính năng, file hoặc code thừa |
| REFACTOR | Sắp xếp lại code, không đổi hành vi |
| FIX | Sửa lỗi |
| DOCS | Sửa tài liệu hoặc comment |
| TEST | Thêm hoặc sửa test |
| CONFIG | Sửa file cấu hình (docker-compose, .env.example, git config...) |
| STYLE | Đổi định dạng, không ảnh hưởng logic |
| PERF | Cải thiện hiệu năng |
| BUILD | Script build hoặc dependency (package.json, lockfile) |
| CI | Pipeline CI/CD (.github/workflows) |

Ví dụ tốt: `[FIX] Preserve aspect ratio when transcoding HLS variants`.
Ví dụ bị từ chối: `Fixed bug`, `[FIX] Update code`, `[fix] lowercase namespace`.

## Quy trình

1. Chạy `git status` và `git diff` để xem toàn bộ thay đổi.
2. Chia thay đổi thành các commit nhỏ, mỗi commit một việc. Các thay đổi thuộc cùng một tính năng thì để chung một commit. Ví dụ: sửa logic và test của chính logic đó có thể đi cùng nhau, còn sửa README thì tách thành `[DOCS]`.
3. Trước khi stage, kiểm tra trong phần diff:
   - không còn `console.log` dùng để debug tạm, `debugger;` hay đoạn code bị comment bỏ đi;
   - thụt lề và khoảng trắng nhất quán với file xung quanh;
   - không có file `.env`, `node_modules/`, `temp/`.
4. Chạy test của package bị ảnh hưởng (`npm test` trong `src/api` hoặc `src/transcode-worker`). Nếu test fail vì lý do không liên quan (ví dụ thiếu AWS credentials), ghi rõ điều đó khi báo lại cho người dùng.
5. Stage đúng các file của commit đó bằng `git add <path>`, không dùng `git add -A`.
6. Commit bằng heredoc để giữ nguyên định dạng:
   ```bash
   git commit -F - <<'MSG'
   [FIX] Preserve aspect ratio when transcoding HLS variants

   Scale on the short side so portrait sources are not squashed.
   MSG
   ```
7. Nếu hook từ chối commit, sửa lại message rồi commit lại. Không dùng `--no-verify`.

## Git hook

Repo có hook trong `.githooks/` để kiểm tra quy ước ngay lúc commit:

- `commit-msg` kiểm tra namespace, độ dài dòng đầu, mô tả quá ngắn hoặc chung chung, dấu chấm cuối. Bỏ qua các commit do git tự tạo (Merge, Revert, fixup!).
- `pre-commit` chặn conflict marker và `debugger;` trong các file đã stage.

Mỗi bản clone cần bật hook một lần:

```bash
git config core.hooksPath .githooks
```

Nếu `git config core.hooksPath` không trả về `.githooks`, hãy bật hook trước khi commit.
