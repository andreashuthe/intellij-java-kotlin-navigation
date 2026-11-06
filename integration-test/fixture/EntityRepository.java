package demo;

public interface EntityRepository extends IRepository {
    public boolean contains(Object object);

    public Object load(Object object, Long id);

    public void merge(Object objec);

    public void lock(Object object);

    public Object get(Class clazz, Long id);

    public void flush();
}
