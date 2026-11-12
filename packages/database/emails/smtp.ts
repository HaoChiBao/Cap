import { render } from "@react-email/render";
import { createTransport, type Transporter } from "nodemailer";
import type { JSXElementConstructor, ReactElement } from "react";

export type SmtpSendResult =
	| { data: { id: string } | null; error: null }
	| { data: null; error: { name: string; message: string } };

export type SmtpTransportConfig = {
	host: string;
	port: number;
	secure: boolean;
	user?: string;
	pass?: string;
};

export type SmtpSendInput = {
	from: string;
	to: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	cc?: string | string[];
	replyTo?: string;
	attachments?: {
		filename: string;
		content: Buffer | string;
		contentType?: string;
	}[];
};

export function createSmtpTransport(config: SmtpTransportConfig): Transporter {
	return createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth:
			config.user && config.pass
				? { user: config.user, pass: config.pass }
				: undefined,
	});
}

export function toNodemailerAttachments(
	attachments: SmtpSendInput["attachments"],
) {
	return attachments?.map((attachment) => ({
		filename: attachment.filename,
		content: attachment.content,
		contentType: attachment.contentType,
	}));
}

export async function sendSmtpEmail(
	transporter: Transporter,
	input: SmtpSendInput,
): Promise<SmtpSendResult> {
	try {
		const [html, text] = await Promise.all([
			render(input.react),
			render(input.react, { plainText: true }),
		]);
		const info = await transporter.sendMail({
			from: input.from,
			to: input.to,
			cc: input.cc,
			replyTo: input.replyTo,
			subject: input.subject,
			html,
			text,
			attachments: toNodemailerAttachments(input.attachments),
		});
		return { data: { id: info.messageId }, error: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`[email] SMTP rejected email "${input.subject}" from ${input.from}:`,
			message,
		);
		return {
			data: null,
			error: { name: "smtp_error", message },
		};
	}
}
