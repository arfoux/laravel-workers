<?php

// tools/schedule-dump.php — dump the app's schedule (build time only).
//
// The edge cannot run an artisan command, but it *can* trigger it: the schedule
// becomes a Cloudflare Cron Trigger (the padanan — Free allows 5 triggers per
// account) and the due event is queued for the app runtime that still exists.
//
// Usage: php tools/schedule-dump.php
//   stdout: {"events":[{"name","expression","command","description","timezone",
//                       "cron_triggerable":bool,"reason":string|null}], ...}

require_once __DIR__ . '/_root.php';
$root = lw_app_root();

require lw_vendor_autoload();

$app = require $root . '/bootstrap/app.php';

$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

$out = ['events' => []];

try {
    // Laravel 11+: the console kernel resolves the schedule; the events carry the
    // cron expression, the command and the flags we need.
    $schedule = method_exists($kernel, 'resolveSchedule')
        ? $kernel->resolveSchedule()
        : (function_exists('app') && app()->bound(Illuminate\Console\Scheduling\Schedule::class)
            ? app(Illuminate\Console\Scheduling\Schedule::class)
            : null);

    if ($schedule === null) {
        $out['error'] = 'the console kernel does not expose a schedule';
    } else {
        foreach ($schedule->events() as $event) {
            $command = $event->command ?? null;
            $expression = $event->expression ?? null;
            $timezone = $event->timezone ?? null;

            // Laravel builds the command with the PHP binary (".../php artisan
            // inspire"); the edge only needs the artisan command name.
            $commandName = $command;
            if (is_string($command)) {
                if (preg_match('/artisan"?\s+(.*)$/i', $command, $m)) $commandName = trim($m[1]);
                else $commandName = basename($command);
            }

            // A Cloudflare Cron Trigger uses the standard 5-field cron (UTC). The
            // "@daily"-style aliases and the seconds field are not supported.
            $triggerable = true;
            $reason = null;
            if ($expression === null || $expression === '') {
                $triggerable = false;
                $reason = 'the event has no cron expression';
            } elseif (substr_count(trim($expression), ' ') !== 4) {
                $triggerable = false;
                $reason = 'the cron expression is not a 5-field expression';
            } elseif (str_starts_with(trim($expression), '@')) {
                $triggerable = false;
                $reason = 'the @alias cron expressions are not supported by Cloudflare';
            }

            $out['events'][] = [
                'name' => $event->description ?? ($commandName ?: 'closure'),
                'expression' => $expression,
                'command' => $commandName,
                'description' => $event->description ?? null,
                'timezone' => $timezone,
                'without_overlapping' => (bool) ($event->withoutOverlapping ?? false),
                'on_one_server' => (bool) ($event->onOneServer ?? false),
                'cron_triggerable' => $triggerable,
                'reason' => $reason,
            ];
        }
    }
} catch (Throwable $e) {
    $out['error'] = get_class($e) . ': ' . $e->getMessage();
}

echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
