# frozen_string_literal: true

# Asks App Store Connect, with the same API key xcodebuild uses, what the
# app's App IDs look like, so a signing failure can be told apart from a bad
# key. Prints no secrets: only whether the key material is well formed,
# Apple's HTTP status and error codes, and each App ID's capabilities.
#
# Usage: ruby asc_diagnose.rb <path to AuthKey_*.p8> <bundle id>...
# Reads ASC_KEY_ID and ASC_ISSUER_ID from the environment.

require "base64"
require "json"
require "net/http"
require "openssl"
require "uri"

key_path, *bundle_ids = ARGV
key_id = ENV.fetch( "ASC_KEY_ID", "" )
issuer_id = ENV.fetch( "ASC_ISSUER_ID", "" )
pem = File.exist?( key_path.to_s ) ? File.read( key_path ) : ""

puts "Key ID is 10 uppercase letters/digits: #{key_id.match?( /\A[A-Z0-9]{10}\z/ )}"
puts "Issuer ID is a UUID: #{issuer_id.match?( /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/ )}"
puts "Key file is a PEM private key: #{pem.include?( '-----BEGIN PRIVATE KEY-----' )}"

begin
  key = OpenSSL::PKey::EC.new( pem )
rescue OpenSSL::PKey::PKeyError, ArgumentError => e
  puts "Key file does not parse as an EC key: #{e.class}"
  exit 0
end
puts "Key curve: #{key.group.curve_name}"

def b64url( data ) = Base64.urlsafe_encode64( data, padding: false )

# ES256 wants the raw 64-byte r||s, not OpenSSL's DER signature
def es256( key, data )
  der = key.sign( OpenSSL::Digest.new( "SHA256" ), data )
  OpenSSL::ASN1.decode( der ).value.map {| n | n.value.to_s( 2 ).rjust( 32, "\0" ) }.join
end

now = Time.now.to_i
header = b64url( JSON.generate( alg: "ES256", kid: key_id, typ: "JWT" ) )
payload = b64url( JSON.generate( iss: issuer_id, iat: now, exp: now + 600, aud: "appstoreconnect-v1" ) )
token = "#{header}.#{payload}.#{b64url( es256( key, "#{header}.#{payload}" ) )}"

def get( token, path )
  uri = URI( "https://api.appstoreconnect.apple.com#{path}" )
  request = Net::HTTP::Get.new( uri )
  request["Authorization"] = "Bearer #{token}"
  Net::HTTP.start( uri.host, uri.port, use_ssl: true, open_timeout: 20, read_timeout: 30 ) do | http |
    http.request( request )
  end
end

def report_errors( body )
  ( JSON.parse( body )["errors"] || [] ).each do | error |
    puts "  #{error['status']} #{error['code']}: #{error['title']} - #{error['detail']}"
  end
rescue JSON::ParserError
  puts "  (response is not JSON)"
end

# Any key that can sign in can list apps, so this separates a rejected key
# from a key that lacks a particular permission.
response = get( token, "/v1/apps?limit=1&fields[apps]=bundleId" )
puts "GET /v1/apps: HTTP #{response.code}"
report_errors( response.body ) unless response.is_a?( Net::HTTPSuccess )

bundle_ids.each do | bundle_id |
  query = URI.encode_www_form(
    "filter[identifier]" => bundle_id,
    "include" => "bundleIdCapabilities",
    "limit" => 10
  )
  response = get( token, "/v1/bundleIds?#{query}" )
  puts "GET /v1/bundleIds for #{bundle_id}: HTTP #{response.code}"
  unless response.is_a?( Net::HTTPSuccess )
    report_errors( response.body )
    next
  end
  body = JSON.parse( response.body )
  # The filter matches prefixes too, so pick out the exact App ID
  app_id = ( body["data"] || [] ).find {| d | d.dig( "attributes", "identifier" ) == bundle_id }
  unless app_id
    puts "  No App ID registered with exactly this identifier"
    next
  end
  capability_ids = ( app_id.dig( "relationships", "bundleIdCapabilities", "data" ) || [] ).map {| c | c["id"] }
  ( body["included"] || [] ).select {| c | capability_ids.include?( c["id"] ) }.each do | capability |
    settings = ( capability.dig( "attributes", "settings" ) || [] ).map do | setting |
      enabled = ( setting["options"] || [] ).select {| o | o["enabled"] }.map {| o | o["key"] }
      "#{setting['key']}=#{enabled.join( '+' )}"
    end
    puts "  #{capability.dig( 'attributes', 'capabilityType' )} #{settings.join( ' ' )}".rstrip
  end
end
