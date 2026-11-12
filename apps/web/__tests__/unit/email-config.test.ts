import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | number | boolean | undefined>,
	build: {} as Record<string, string | undefined>,
	send: vi.fn(),
	smtpSendMail: vi.fn(),
	render: vi.fn(async (_react: unknown, options?: { plainText?: boolean }) =>
		options?.plainText ? "hi" : "<p>hi</p>",
	),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => mocks.env,
	buildEnv: mocks.build,
}));

vi.mock("resend", () => ({
	Resend: class {
		emails = { send: mocks.send };
	},
}));

vi.mock("@react-email/render", () => ({
	render: mocks.render,
}));

vi.mock("nodemailer", () => ({
	createTransport: () => ({
		sendMail: mocks.smtpSendMail,
	}),
}));

import {
	getEmailDeliveryStatus,
	resolveEmailProvider,
	sendEmail,
} from "@cap/database/emails/config";

const message = {
	email: "user@example.com",
	subject: "Hello",
	react: createElement("p", null, "hi"),
};

describe("email config", () => {
	beforeEach(() => {
		mocks.send.mockReset();
		mocks.smtpSendMail.mockReset();
		mocks.render.mockClear();
		for (const key of Object.keys(mocks.env)) delete mocks.env[key];
		for (const key of Object.keys(mocks.build)) delete mocks.build[key];
	});

	it("reports missing email configuration", () => {
		const status = getEmailDeliveryStatus();
		expect(status.configured).toBe(false);
		expect(status.configured ? "" : status.reason).toContain(
			"Email is not configured",
		);
	});

	it.each([undefined, "", "false"])(
		"requires a sender domain with NEXT_PUBLIC_IS_CAP=%j",
		async (isCap) => {
			mocks.build.NEXT_PUBLIC_IS_CAP = isCap;
			mocks.env.RESEND_API_KEY = "re_test";
			expect(getEmailDeliveryStatus().configured).toBe(false);

			const result = await sendEmail(message);
			expect(mocks.send).not.toHaveBeenCalled();
			expect(result?.error?.name).toBe("email_not_configured");
		},
	);

	it("sends an explicit sender without a default from-domain", async () => {
		mocks.env.RESEND_API_KEY = "re_test";
		mocks.send.mockResolvedValue({ data: { id: "email_2" }, error: null });

		const result = await sendEmail({
			...message,
			fromOverride: "Cap Support <richie@send.cap.so>",
		});

		expect(mocks.send.mock.calls[0]?.[0].from).toBe(
			"Cap Support <richie@send.cap.so>",
		);
		expect(result).toEqual({ data: { id: "email_2" }, error: null });
	});

	it.each([undefined, "false"])(
		"sends from the configured domain with NEXT_PUBLIC_IS_CAP=%j",
		async (isCap) => {
			mocks.build.NEXT_PUBLIC_IS_CAP = isCap;
			mocks.env.RESEND_API_KEY = "re_test";
			mocks.env.RESEND_FROM_DOMAIN = "example.com";
			mocks.send.mockResolvedValue({ data: { id: "email_1" }, error: null });

			const result = await sendEmail(message);
			expect(mocks.send.mock.calls[0]?.[0].from).toBe("auth@example.com");
			expect(result).toEqual({ data: { id: "email_1" }, error: null });
		},
	);

	it("uses the Cap Cloud sender when explicitly enabled", async () => {
		mocks.build.NEXT_PUBLIC_IS_CAP = "true";
		mocks.env.RESEND_API_KEY = "re_test";
		mocks.send.mockResolvedValue({ data: { id: "cloud_email" }, error: null });

		expect(getEmailDeliveryStatus().configured).toBe(true);
		await sendEmail(message);

		expect(mocks.send.mock.calls[0]?.[0].from).toBe(
			"Cap Auth <no-reply@auth.cap.so>",
		);
	});

	it.each([undefined, "false"])(
		"skips marketing on self-hosts with NEXT_PUBLIC_IS_CAP=%j",
		async (isCap) => {
			mocks.build.NEXT_PUBLIC_IS_CAP = isCap;
			mocks.env.RESEND_API_KEY = "re_test";
			mocks.env.RESEND_FROM_DOMAIN = "example.com";
			mocks.send.mockResolvedValue({ data: { id: "marketing" }, error: null });

			await sendEmail({ ...message, marketing: true });

			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	it("surfaces provider rejections instead of claiming success", async () => {
		mocks.env.RESEND_API_KEY = "re_test";
		mocks.env.RESEND_FROM_DOMAIN = "example.com";
		mocks.send.mockResolvedValue({
			data: null,
			error: { name: "validation_error", message: "domain not verified" },
		});

		const result = await sendEmail(message);
		expect(result?.error?.message).toBe("domain not verified");
	});

	it("defaults to resend when only RESEND_API_KEY is set", () => {
		mocks.env.RESEND_API_KEY = "re_test";
		mocks.env.SMTP_HOST = "smtp.example.com";
		expect(resolveEmailProvider(mocks.env as never)).toEqual({
			name: "resend",
		});
	});

	it("selects smtp only when EMAIL_PROVIDER=smtp and SMTP_HOST is set", () => {
		mocks.env.EMAIL_PROVIDER = "smtp";
		expect(resolveEmailProvider(mocks.env as never)).toBeNull();

		mocks.env.SMTP_HOST = "smtp.example.com";
		expect(resolveEmailProvider(mocks.env as never)).toEqual({
			name: "smtp",
			host: "smtp.example.com",
		});
		expect(getEmailDeliveryStatus().configured).toBe(false);

		mocks.env.EMAIL_FROM = "Cap <auth@example.com>";
		const status = getEmailDeliveryStatus();
		expect(status).toEqual({ configured: true, provider: "smtp" });
	});

	it("passes attachments and idempotencyKey on the resend path", async () => {
		mocks.env.RESEND_API_KEY = "re_test";
		mocks.env.RESEND_FROM_DOMAIN = "example.com";
		mocks.send.mockResolvedValue({ data: { id: "email_att" }, error: null });

		await sendEmail({
			...message,
			attachments: [
				{
					filename: "note.txt",
					content: "hello",
					contentType: "text/plain",
				},
			],
			idempotencyKey: "key-1",
			scheduledAt: "in 5 min",
		});

		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				attachments: [
					{
						filename: "note.txt",
						content: "hello",
						contentType: "text/plain",
					},
				],
				scheduledAt: "in 5 min",
			}),
			{ idempotencyKey: "key-1" },
		);
	});

	it("routes smtp sends with attachments and warns on schedule/idempotency", async () => {
		mocks.env.EMAIL_PROVIDER = "smtp";
		mocks.env.SMTP_HOST = "smtp.example.com";
		mocks.env.SMTP_PORT = 587;
		mocks.env.SMTP_SECURE = false;
		mocks.env.EMAIL_FROM = "Cap <auth@example.com>";
		mocks.smtpSendMail.mockResolvedValue({
			messageId: "<smtp-id@example.com>",
		});

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await sendEmail({
			...message,
			scheduledAt: "in 5 min",
			idempotencyKey: "key-smtp",
			attachments: [
				{
					filename: "note.txt",
					content: "hello",
					contentType: "text/plain",
				},
			],
		});

		expect(mocks.send).not.toHaveBeenCalled();
		expect(mocks.smtpSendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				from: "Cap <auth@example.com>",
				to: "user@example.com",
				subject: "Hello",
				html: "<p>hi</p>",
				attachments: [
					{
						filename: "note.txt",
						content: "hello",
						contentType: "text/plain",
					},
				],
			}),
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("sending immediately"),
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("idempotencyKey"),
		);
		expect(result).toEqual({
			data: { id: "<smtp-id@example.com>" },
			error: null,
		});

		warn.mockRestore();
	});

	it("returns smtp transport failures as { data, error }", async () => {
		mocks.env.EMAIL_PROVIDER = "smtp";
		mocks.env.SMTP_HOST = "smtp.example.com";
		mocks.env.EMAIL_FROM = "Cap <auth@example.com>";
		mocks.smtpSendMail.mockRejectedValue(new Error("relay denied"));

		const result = await sendEmail(message);

		expect(result).toEqual({
			data: null,
			error: { name: "smtp_error", message: "relay denied" },
		});
	});
});
