import { buildEnv, serverEnv } from "@cap/env";
import type { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";
import { createSmtpTransport, sendSmtpEmail } from "./smtp.ts";

export const resend = () =>
	serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

export const EMAIL_NOT_CONFIGURED_MESSAGE = "Email is not configured";

export type EmailProviderName = "resend" | "smtp";

export type EmailDeliveryStatus =
	| { configured: true; provider: EmailProviderName }
	| { configured: false; reason: string };

export function resolveEmailProvider(
	env: ReturnType<typeof serverEnv> = serverEnv(),
): EmailProviderName | null {
	const requested =
		env.EMAIL_PROVIDER ?? (env.RESEND_API_KEY ? "resend" : null);
	if (requested === "smtp") return env.SMTP_HOST?.trim() ? "smtp" : null;
	if (requested === "resend") return env.RESEND_API_KEY ? "resend" : null;
	return null;
}

function resolveFromAddress(
	env: ReturnType<typeof serverEnv>,
	{
		fromOverride,
		marketing,
	}: {
		fromOverride?: string;
		marketing?: boolean;
	},
): string | undefined {
	if (fromOverride) return fromOverride;
	if (marketing) return "Richie from Cap <richie@send.cap.so>";
	if (buildEnv.NEXT_PUBLIC_IS_CAP === "true") {
		return "Cap Auth <no-reply@auth.cap.so>";
	}
	if (env.EMAIL_FROM?.trim()) return env.EMAIL_FROM.trim();
	if (env.RESEND_FROM_DOMAIN?.trim()) {
		return `auth@${env.RESEND_FROM_DOMAIN.trim()}`;
	}
	return undefined;
}

export function getEmailDeliveryStatus(): EmailDeliveryStatus {
	const env = serverEnv();
	const provider = resolveEmailProvider(env);

	if (!provider) {
		if (env.EMAIL_PROVIDER === "smtp") {
			return {
				configured: false,
				reason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: SMTP_HOST is not set`,
			};
		}
		if (env.EMAIL_PROVIDER === "resend") {
			return {
				configured: false,
				reason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: RESEND_API_KEY is not set`,
			};
		}
		return {
			configured: false,
			reason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: set RESEND_API_KEY or EMAIL_PROVIDER=smtp with SMTP_HOST`,
		};
	}

	if (provider === "smtp") {
		if (!env.EMAIL_FROM?.trim() && buildEnv.NEXT_PUBLIC_IS_CAP !== "true") {
			return {
				configured: false,
				reason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: EMAIL_FROM is not set`,
			};
		}
		return { configured: true, provider };
	}

	if (
		buildEnv.NEXT_PUBLIC_IS_CAP !== "true" &&
		!env.EMAIL_FROM?.trim() &&
		!env.RESEND_FROM_DOMAIN?.trim()
	) {
		return {
			configured: false,
			reason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: EMAIL_FROM or RESEND_FROM_DOMAIN is not set`,
		};
	}
	return { configured: true, provider };
}

export const isEmailDeliveryConfigured = () =>
	getEmailDeliveryStatus().configured;

let warnedEmailNotConfigured = false;

function warnEmailNotConfigured(reason: string) {
	if (warnedEmailNotConfigured) return;
	warnedEmailNotConfigured = true;
	console.warn(
		`[email] ${reason}. Emails will not be sent; login codes are printed to the server log instead.`,
	);
}

export type SendEmailResult =
	| { data: { id: string } | null; error: null }
	| { data: null; error: { name: string; message: string } };

export const sendEmail = async ({
	email,
	subject,
	react,
	marketing,
	test,
	scheduledAt,
	cc,
	replyTo,
	fromOverride,
	idempotencyKey,
	attachments,
}: {
	email: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	marketing?: boolean;
	test?: boolean;
	scheduledAt?: string;
	cc?: string | string[];
	replyTo?: string;
	fromOverride?: string;
	idempotencyKey?: string;
	attachments?: {
		filename: string;
		content: Buffer | string;
		contentType?: string;
	}[];
}): Promise<SendEmailResult | undefined> => {
	const env = serverEnv();
	const provider = resolveEmailProvider(env);
	if (!provider) {
		const status = getEmailDeliveryStatus();
		const reason =
			status.configured === false
				? status.reason
				: EMAIL_NOT_CONFIGURED_MESSAGE;
		warnEmailNotConfigured(reason);
		return {
			data: null,
			error: { name: "email_not_configured", message: reason },
		};
	}

	const isCap = buildEnv.NEXT_PUBLIC_IS_CAP === "true";
	if (marketing && !isCap) return;

	const from = resolveFromAddress(env, { fromOverride, marketing });
	if (!from?.includes("@")) {
		const reason = `${EMAIL_NOT_CONFIGURED_MESSAGE}: EMAIL_FROM or RESEND_FROM_DOMAIN is not set`;
		warnEmailNotConfigured(reason);
		return {
			data: null,
			error: { name: "email_not_configured", message: reason },
		};
	}

	if (provider === "smtp") {
		const host = env.SMTP_HOST?.trim();
		if (!host) {
			const reason = `${EMAIL_NOT_CONFIGURED_MESSAGE}: SMTP_HOST is not set`;
			warnEmailNotConfigured(reason);
			return {
				data: null,
				error: { name: "email_not_configured", message: reason },
			};
		}

		if (scheduledAt) {
			console.warn(
				`[email] scheduledAt requested but provider is smtp — sending immediately`,
			);
		}
		if (idempotencyKey) {
			console.warn(
				`[email] idempotencyKey requested but provider is smtp — ignoring`,
			);
		}

		const user = env.SMTP_USER?.trim();
		const pass = env.SMTP_PASS;
		if (Boolean(user) !== Boolean(pass)) {
			console.warn(
				"[email] Only one of SMTP_USER/SMTP_PASS is set: SMTP auth is disabled. Set both or neither.",
			);
		}

		return sendSmtpEmail(
			createSmtpTransport({
				host,
				port: env.SMTP_PORT ?? 587,
				secure: env.SMTP_SECURE,
				user: user || undefined,
				pass: pass || undefined,
			}),
			{
				from,
				to: email,
				subject,
				react,
				cc: test ? undefined : cc,
				replyTo,
				attachments,
			},
		);
	}

	const r = resend();
	if (!r) {
		const reason = `${EMAIL_NOT_CONFIGURED_MESSAGE}: RESEND_API_KEY is not set`;
		warnEmailNotConfigured(reason);
		return {
			data: null,
			error: { name: "email_not_configured", message: reason },
		};
	}

	const result = await r.emails.send(
		{
			from,
			to: test ? "delivered@resend.dev" : email,
			subject,
			react,
			scheduledAt,
			cc: test ? undefined : cc,
			replyTo: replyTo,
			attachments,
		},
		idempotencyKey ? { idempotencyKey } : undefined,
	);

	if (result.error) {
		console.error(
			`[email] Resend rejected email "${subject}" from ${from}:`,
			result.error.message,
		);
		return {
			data: null,
			error: { name: result.error.name, message: result.error.message },
		};
	}

	return { data: result.data, error: null };
};
