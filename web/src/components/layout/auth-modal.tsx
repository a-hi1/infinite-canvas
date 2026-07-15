import { useState } from "react";
import { App, Form, Input, Modal, Tabs } from "antd";

import { useAuthStore } from "@/stores/use-auth-store";

export function AuthModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const login = useAuthStore((s) => s.login);
    const register = useAuthStore((s) => s.register);
    const [tab, setTab] = useState<"login" | "register">("login");
    const [loading, setLoading] = useState(false);
    const [loginForm] = Form.useForm();
    const [registerForm] = Form.useForm();

    const submitLogin = async () => {
        const values = await loginForm.validateFields();
        setLoading(true);
        try {
            await login(values.email, values.password);
            message.success("登录成功");
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        } finally {
            setLoading(false);
        }
    };

    const submitRegister = async () => {
        const values = await registerForm.validateFields();
        setLoading(true);
        try {
            await register({
                email: values.email,
                password: values.password,
                displayName: values.displayName,
                inviteCode: values.inviteCode,
            });
            message.success("注册成功");
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注册失败");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal
            title="账号"
            open={open}
            onCancel={onClose}
            onOk={() => void (tab === "login" ? submitLogin() : submitRegister())}
            okText={tab === "login" ? "登录" : "注册"}
            confirmLoading={loading}
            destroyOnHidden
        >
            <Tabs
                activeKey={tab}
                onChange={(key) => setTab(key as "login" | "register")}
                items={[
                    {
                        key: "login",
                        label: "登录",
                        children: (
                            <Form form={loginForm} layout="vertical" requiredMark={false}>
                                <Form.Item name="email" label="邮箱" rules={[{ required: true, message: "请输入邮箱" }]}>
                                    <Input autoComplete="email" placeholder="you@example.com" />
                                </Form.Item>
                                <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                                    <Input.Password autoComplete="current-password" placeholder="至少 8 位" />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    {
                        key: "register",
                        label: "注册",
                        children: (
                            <Form form={registerForm} layout="vertical" requiredMark={false}>
                                <Form.Item name="email" label="邮箱" rules={[{ required: true, message: "请输入邮箱" }]}>
                                    <Input autoComplete="email" placeholder="you@example.com" />
                                </Form.Item>
                                <Form.Item name="password" label="密码" rules={[{ required: true, min: 8, message: "密码至少 8 位" }]}>
                                    <Input.Password autoComplete="new-password" placeholder="至少 8 位" />
                                </Form.Item>
                                <Form.Item name="displayName" label="昵称">
                                    <Input placeholder="可选" />
                                </Form.Item>
                                <Form.Item name="inviteCode" label="邀请码">
                                    <Input placeholder="若服务器启用了邀请码则必填" />
                                </Form.Item>
                            </Form>
                        ),
                    },
                ]}
            />
            <div className="text-xs text-stone-500 dark:text-stone-400">登录后可将生成结果保存到服务器历史；未登录仍可完成本地使用。</div>
        </Modal>
    );
}
