import { createTransport } from "nodemailer";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	render: vi.fn(async (_react: unknown, options?: { plainText?: boolean }) =>
		options?.plainText ? "hi" : "<p>hi</p>",
	),
}));

vi.mock("@react-email/render", () => ({
	render: mocks.render,
}));

import {
	sendSmtpEmail,
	toNodemailerAttachments,
} from "@cap/database/emails/smtp";

describe("smtp send mapping", () => {
	beforeEach(() => {
		mocks.render.mockClear();
	});

	it("maps attachments for nodemailer", () => {
		expect(
			toNodemailerAttachments([
				{
					filename: "a.pdf",
					content: Buffer.from("pdf"),
					contentType: "application/pdf",
				},
			]),
		).toEqual([
			{
				filename: "a.pdf",
				content: Buffer.from("pdf"),
				contentType: "application/pdf",
			},
		]);
	});

	it("sends through jsonTransport and returns { data, error }", async () => {
		const transporter = createTransport({ jsonTransport: true });

		const result = await sendSmtpEmail(transporter, {
			from: "Cap <auth@example.com>",
			to: "user@example.com",
			cc: "cc@example.com",
			replyTo: "reply@example.com",
			subject: "Mapped",
			react: createElement("p", null, "body"),
			attachments: [
				{
					filename: "note.txt",
					content: "hello",
					contentType: "text/plain",
				},
			],
		});

		expect(mocks.render).toHaveBeenCalledTimes(2);
		expect(result.error).toBeNull();
		expect(result.data?.id).toBeTruthy();
	});

	it("returns smtp failures as error instead of swallowing them", async () => {
		const transporter = createTransport({ jsonTransport: true });
		vi.spyOn(transporter, "sendMail").mockRejectedValue(
			new Error("connection refused"),
		);

		const result = await sendSmtpEmail(transporter, {
			from: "Cap <auth@example.com>",
			to: "user@example.com",
			subject: "Hello",
			react: createElement("p", null, "hi"),
		});

		expect(result).toEqual({
			data: null,
			error: { name: "smtp_error", message: "connection refused" },
		});
	});
});
