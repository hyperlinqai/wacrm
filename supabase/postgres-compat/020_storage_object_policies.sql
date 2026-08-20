-- Canonical RLS policies on storage.objects (avatars / flow-media /
-- chat-media), snapshotted from pg_policies after migrations 008-039.
-- Re-applied by self-host/first-boot-storage-fix.sh after the Storage
-- API replaces storage.foldername() during its first migration run.

CREATE POLICY "Avatars are publicly readable" ON storage.objects FOR SELECT TO public USING ((bucket_id = 'avatars'::text));
CREATE POLICY "Users can upload their own avatar" ON storage.objects FOR INSERT TO public WITH CHECK (((bucket_id = 'avatars'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can update their own avatar" ON storage.objects FOR UPDATE TO public USING (((bucket_id = 'avatars'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can delete their own avatar" ON storage.objects FOR DELETE TO public USING (((bucket_id = 'avatars'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Flow media is publicly readable" ON storage.objects FOR SELECT TO public USING ((bucket_id = 'flow-media'::text));
CREATE POLICY "Members can upload flow media" ON storage.objects FOR INSERT TO public WITH CHECK (((bucket_id = 'flow-media'::text) AND ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.user_id = auth.uid()) AND (('account-'::text || (p.account_id)::text) = (storage.foldername(objects.name))[1])))) OR ((auth.uid())::text = (storage.foldername(name))[1]))));
CREATE POLICY "Members can update flow media" ON storage.objects FOR UPDATE TO public USING (((bucket_id = 'flow-media'::text) AND ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.user_id = auth.uid()) AND (('account-'::text || (p.account_id)::text) = (storage.foldername(objects.name))[1])))) OR ((auth.uid())::text = (storage.foldername(name))[1]))));
CREATE POLICY "Members can delete flow media" ON storage.objects FOR DELETE TO public USING (((bucket_id = 'flow-media'::text) AND ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.user_id = auth.uid()) AND (('account-'::text || (p.account_id)::text) = (storage.foldername(objects.name))[1])))) OR ((auth.uid())::text = (storage.foldername(name))[1]))));
CREATE POLICY "Chat media is publicly readable" ON storage.objects FOR SELECT TO public USING ((bucket_id = 'chat-media'::text));
CREATE POLICY "Members can upload chat media" ON storage.objects FOR INSERT TO public WITH CHECK (((bucket_id = 'chat-media'::text) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.user_id = auth.uid()) AND (('account-'::text || (p.account_id)::text) = (storage.foldername(objects.name))[1]))))));
CREATE POLICY "Members can update chat media" ON storage.objects FOR UPDATE TO public USING (((bucket_id = 'chat-media'::text) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.user_id = auth.uid()) AND (('account-'::text || (p.account_id)::text) = (storage.foldername(objects.name))[1]))))));
CREATE POLICY "Members can delete chat media" ON storage.objects FOR DELETE TO public USING (((bucket_id = 'chat-media'::text) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.user_id = auth.uid()) AND (('account-'::text || (p.account_id)::text) = (storage.foldername(objects.name))[1]))))));
