//! Built-in agent debug scenarios for regression testing (browser E2E, etc.).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DebugScenario {
    pub id: String,
    pub name: String,
    pub name_en: String,
    pub description: String,
    pub description_en: String,
    pub prompt: String,
    pub expected_keywords: Vec<String>,
    pub expected_tools: Vec<String>,
}

pub fn builtin_scenarios() -> Vec<DebugScenario> {
    vec![
        DebugScenario {
            id: "browser_headless_search".into(),
            name: "Headless 浏览器搜索".into(),
            name_en: "Headless Browser Search".into(),
            description: "使用 headless 浏览器访问搜索引擎，验证 browser 工具".into(),
            description_en: "Use headless browser to search, verify browser tool".into(),
            prompt: "请用 browser 工具（headless 模式）完成：\
                     1. 访问 https://www.bing.com \
                     2. 搜索「Piscis AI Agent」并提交 \
                     3. 获取页面标题和前 3 条结果标题 \
                     注意：headless=true，不要打开可见窗口。"
                .into(),
            expected_keywords: vec!["搜索".into(), "bing".into(), "Bing".into()],
            expected_tools: vec!["browser".into()],
        },
        DebugScenario {
            id: "browser_headless_screenshot".into(),
            name: "Headless 浏览器截图".into(),
            name_en: "Headless Browser Screenshot".into(),
            description: "访问 example.com 并截图保存".into(),
            description_en: "Visit example.com and save screenshot".into(),
            prompt: "请用 browser 工具（headless=true）：\
                     1. 访问 https://example.com \
                     2. wait_for navigation \
                     3. screenshot 保存到工作区 .agentz/screenshots/debug_browser.png \
                     4. 报告页面标题与保存路径"
                .into(),
            expected_keywords: vec!["Example".into(), "example.com".into()],
            expected_tools: vec!["browser".into()],
        },
        DebugScenario {
            id: "browser_login_hint".into(),
            name: "浏览器登录场景".into(),
            name_en: "Browser Login Scenario".into(),
            description: "打开 GitHub 登录页，验证人工介入提示".into(),
            description_en: "Open GitHub login, verify human-in-the-loop guidance".into(),
            prompt: "请用 browser 工具：\
                     1. 访问 https://github.com/login \
                     2. 确认登录表单存在 \
                     3. 不要实际登录；说明如需真实登录用户应如何介入"
                .into(),
            expected_keywords: vec!["登录".into(), "GitHub".into(), "login".into()],
            expected_tools: vec!["browser".into()],
        },
        DebugScenario {
            id: "browser_embedded_snapshot_e2e".into(),
            name: "嵌入式 Browser E2E（snapshot/ref）".into(),
            name_en: "Embedded Browser E2E (snapshot/ref)".into(),
            description: "CodeZ 嵌入式浏览器：snapshot → assert_url 流程".into(),
            description_en: "CodeZ embedded browser: snapshot → assert_url workflow".into(),
            prompt: "请用 browser 工具驱动 IDE 嵌入式浏览器（不要 headless）：\
                     1. navigate 到 https://example.com \
                     2. lock → snapshot(interactive=true) \
                     3. assert_url text=example.com \
                     4. assert_title text=Example \
                     5. screenshot save_path=.agentz/screenshots/e2e_example.png \
                     6. unlock \
                     报告 PASS/FAIL 与截图路径"
                .into(),
            expected_keywords: vec!["PASS".into(), "example.com".into(), "Example".into()],
            expected_tools: vec!["browser".into()],
        },
    ]
}

#[tauri::command]
pub fn debug_scenarios_list() -> Vec<DebugScenario> {
    builtin_scenarios()
}
