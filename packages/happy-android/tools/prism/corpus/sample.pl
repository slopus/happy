#!/usr/bin/perl
use strict; use warnings;
# comment
my %h = (name => 'perl', count => 42);
my @list = map { $_ * 2 } (1..10);
sub greet { my ($who) = @_; return "Hello, $who\n"; }
print greet($h{name}) if $h{count} =~ /\d+/;
