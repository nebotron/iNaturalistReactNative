#!/usr/bin/env ruby
# frozen_string_literal: true

# Run the setup steps of the TestFlight workflow as it stood at the checked-out
# commit, so a rebuild of an old build prepares .env, the models and the Pods
# the way that build did rather than the way today's workflow does.
#
# Usage: replay_build_steps.rb PREBUILT_REACT_NATIVE STEP_NAME...
# Run from the root of the old checkout. Secrets a step reads must be in this
# process's environment under their own names.

require "yaml"
require "open3"

prebuilt, *wanted = ARGV
abort "usage: #{$PROGRAM_NAME} true|false STEP_NAME..." if wanted.empty?

# The build moved from testflight-ios.yml into testflight-ios-build.yml; read
# whichever holds the steps.
steps = %w[testflight-ios-build.yml testflight-ios.yml].flat_map do | file |
  path = File.join( ".github/workflows", file )
  next [] unless File.exist?( path )

  ( YAML.load_file( path )["jobs"] || {} ).values.flat_map { | job | job["steps"] || [] }
end

def substitute( text, prebuilt )
  text.to_s.gsub( /\$\{\{\s*(.+?)\s*\}\}/ ) do
    case ( expression = Regexp.last_match( 1 ) )
    when "inputs.prebuilt_react_native" then prebuilt
    when /\Asecrets\.(\w+)\z/ then ENV.fetch( Regexp.last_match( 1 ), "" )
    when /\Aenv\.(\w+)\z/ then ENV.fetch( Regexp.last_match( 1 ), "" )
    else abort "Can't evaluate ${{ #{expression} }} outside Actions"
    end
  end
end

wanted.each do | name |
  step = steps.find { | s | s["name"] == name }
  unless step
    puts "::notice::This commit's workflow has no \"#{name}\" step; skipping it"
    next
  end
  if step["if"]
    puts "::notice::Skipping \"#{name}\", which only ran if #{step['if']}"
    next
  end
  env = ( step["env"] || {} ).to_h { | k, v | [k, substitute( v, prebuilt )] }
  script = substitute( step["run"], prebuilt )
  puts "::group::#{name}"
  puts script
  status = system( env, "bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script )
  puts "::endgroup::"
  abort "\"#{name}\" failed" unless status
end
