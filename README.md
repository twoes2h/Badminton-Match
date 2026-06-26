# 羽毛球匹配房间

一个面向 30-100 人小规模运动群的 Node.js + MariaDB 匹配系统。当前默认运动是羽毛球，数据结构保留了 `sport_key`，后续可以扩展到乒乓球、篮球等运动。

## 已实现功能

- 用户注册/登录：性别、出生年份、积分、技术等级、角色、黑名单。
- 房间：房间号、房间名、房间密码、场地数、在线人数上限、自由匹配/固定场次。
- 房间限制：
  - 一个用户同一时间只能在一个当前房间里。
  - 一个用户同一时间只能创建一个当前房间。
  - 房间创建者不能离开自己的房间，只能解散该房间。
  - 房间模式创建后固定；自由匹配房间不能发起固定场次，固定场次房间不能发起自由匹配。
  - 解散后的房间不出现在普通房间列表，只在管理员“已解散”筛选里查看。
- 成员状态：空闲、等待匹配、休息、忙碌、比赛中、待成绩、锁定。
- 匹配方式：男双、女双、混双、男单、女单、男女单打。
- 匹配偏好支持多选：例如同一个人可以同时选择男双、混双、男单。
- 匹配策略：
  - 只选择同房间、在线、未黑名单、未忙碌、未比赛、未待成绩的成员。
  - 等待匹配优先；休息状态只在人不够时补位。
  - 固定场次会记录休息轮次，让上一轮没打的人下一轮优先。
  - 根据积分和技术等级平衡红蓝双方。
  - 根据当日同场历史增加重复惩罚，减少同一批人反复匹配。
  - 连续出场次数越高，下一轮优先级越低。
- 比赛流程：
  - 任意参赛者点结束或退出，整场进入待成绩。
  - 所有参赛者提交结果后才释放为可继续匹配。
  - 支持赢、输、平、终止，也支持输入红蓝比分。
  - 有比分时优先按比分判定；多个比分冲突且没有多数时判为无效。
  - 无效记录比赛场次加 1，积分不变。
  - 结果一致但分差不同，按分差平均值计算积分。
- 管理员：
  - 解散房间、调整场地数和在线上限。
  - 查看当前房间或已解散房间。
  - 拉黑/解除拉黑用户。
  - 手动修改房间成员状态，避免未提交结果导致锁死。

## 快速启动

1. 安装 Node.js 20+ 和 MariaDB 10.6+。
2. 创建数据库和账号：

```sql
CREATE DATABASE badminton_match CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'badminton'@'%' IDENTIFIED BY 'badminton_password';
GRANT ALL PRIVILEGES ON badminton_match.* TO 'badminton'@'%';
FLUSH PRIVILEGES;
```

3. 安装依赖：

```bash
npm install
```

4. 复制环境变量：

```bash
cp .env.example .env
```

5. 修改 `.env` 里的数据库密码和 `SESSION_SECRET`。

6. 启动：

```bash
npm start
```

默认访问地址是 `http://localhost:3000`。首次启动会自动执行 `schema.sql`。如果 `.env` 设置了 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`，会自动创建管理员；否则第一个注册用户会成为管理员。

## 页面入口

- `/login.html`：登录和注册。
- `/rooms.html`：房间搜索、创建和进入。
- `/room.html?id=房间ID`：房间内状态、匹配、成员和比赛结果。
- `/admin.html`：管理员房间和用户管理。

## NAS 部署建议

- 用 NAS 套件或 Docker 安装 MariaDB。
- 用 `pm2` 或 NAS 自带服务管理器守护 `npm start`。
- 只在家庭/内网使用时可以直接监听 `3000`；公网访问请加反向代理和 HTTPS。
- `express-session` 当前使用内存会话，个人小规模使用足够；如果扩到长期公网多人使用，建议换成 MariaDB/Redis session store。

### 群晖/NAS 简单启停

项目里提供了两个脚本：

```bash
sh scripts/start-nas.sh
sh scripts/stop-nas.sh
```

如果要开机自启，可以在群晖“控制面板 → 任务计划”里新增“触发的任务 → 用户定义的脚本”，触发事件选择“开机”，脚本内容填写：

```bash
cd /volume1/Tools/羽毛球匹配项目
sh scripts/start-nas.sh
```

## 主要文件

- `src/server.js`：Express 和 Socket.IO 入口。
- `src/routes/auth.js`：注册、登录、退出、当前用户。
- `src/routes/rooms.js`：房间、状态、匹配、比赛结果。
- `src/routes/admin.js`：管理员接口。
- `src/services/matching.js`：匹配算法。
- `src/services/results.js`：结果判定和积分结算。
- `schema.sql`：MariaDB 表结构。
- `public/`：单页前端。

## 检查

```bash
npm run check
```

该命令做 JavaScript 语法检查。完整运行需要本机已安装依赖并能连接 MariaDB。

## 履历导出

比赛履历默认保存在 MariaDB 的 `matches`、`match_players`、`match_results`、`rating_events` 表中。场次很大时可以按天导出 JSONL 文件归档：

```bash
npm run history:export -- 2026-06-26
```

导出文件位于 `data/history/YYYY-MM-DD.jsonl`。数据库仍保留索引用于按房间、用户和日期查询。
